import path from "node:path";
import { Command } from "commander";
import { projectCreatedResponse, projectListResponse, type ProjectView } from "@kanban-hub/core/api";
import { formatZodError } from "@kanban-hub/core/errors";
import { locationInput, projectCreateInput, projectSchema, type Project } from "@kanban-hub/core/schema";
import { SYNC_DEFAULT_MAX_FILE_SIZE } from "@kanban-hub/core/sync";
import type { CliContext } from "../context";
import { CliError, EXIT } from "../errors";
import type { ApiClient } from "../http/client";
import { confirm } from "../prompt";
import { formatByteSize, toSyncScope, writeRepoConfig, type RepoConfig } from "../repo/config";
import { planExclude, ensureExcluded } from "../repo/exclude";
import { fingerprint } from "../repo/fingerprint";
import { findRegisteredRepo, inspectRepo, type RegisteredRepo, type RepoInspection } from "../repo/root";
import { suggestSyncInclude, validateSyncGlob } from "../repo/scope";
import { globalAgentFlag, loadProject, requireLogin } from "./shared";

/** --bind 接受完整 ID 或至少 4 位的前缀，字符集和 core 的 ID 前缀写法一致（见 refs.ts） */
const BIND_REF_RE = /^[0-9a-z]{4,10}$/;

interface RegisterOptions {
  name?: string;
  bind?: string;
  new?: boolean;
  include?: string[];
  dryRun?: boolean;
  yes?: boolean;
}

/** --include 可重复传入；不设默认值，这样没传时 opts.include 是 undefined（区别于“传了空值”） */
function collectInclude(value: string, previous: string[] | undefined): string[] {
  return (previous ?? []).concat([value]);
}

/** 项目名默认取仓库根目录的目录名（规格没写、本计划定下的细节） */
export function defaultProjectName(root: string): string {
  return path.basename(root);
}

function describeProjects(projects: readonly ProjectView[]): string {
  return projects.map((p) => `${p.project.name}（${p.project.id}）`).join("、");
}

/**
 * 解析 --bind：完整 ID 或唯一前缀（至少 4 位）。写法本身不合法（少于 4 位、含非法字符）
 * 是用法错误（2）；写法合法但在项目列表里找不到或匹配到多个是数据错误（5）。
 */
export function resolveBindProject(projects: readonly ProjectView[], rawRef: string): ProjectView {
  const ref = rawRef.trim().toLowerCase();
  if (!BIND_REF_RE.test(ref)) {
    throw new CliError(
      EXIT.USAGE,
      `--bind 的写法不合法：${rawRef}`,
      "至少写 4 位，只能包含数字和小写字母（完整项目 ID 或前缀）",
    );
  }
  const matches = projects.filter((p) => p.project.id.startsWith(ref));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    throw new CliError(EXIT.DATA, `找不到匹配 --bind ${rawRef} 的项目`);
  }
  throw new CliError(EXIT.DATA, `--bind ${rawRef} 匹配到多个项目，请多写几位`, describeProjects(matches));
}

type PlanAction = { kind: "bind"; project: ProjectView } | { kind: "new" };

function repoConfigPathFor(root: string): string {
  return path.join(root, ".kanban-hub", "config.yaml");
}

function buildPlanLines(opts: {
  root: string;
  fp: string | null;
  matches: readonly ProjectView[];
  action: PlanAction;
  name: string;
  include: readonly string[];
  excludePath: string | null;
  warning?: string;
}): string[] {
  const lines: string[] = [
    `仓库根：${opts.root}`,
    `指纹：${opts.fp ?? "无（不是 git 仓库）"}`,
    `匹配到的项目：${opts.matches.length > 0 ? describeProjects(opts.matches) : "无"}`,
    opts.action.kind === "bind"
      ? `动作：绑定到已有项目 ${opts.action.project.project.name}（${opts.action.project.project.id}）`
      : `动作：新建项目「${opts.name}」`,
  ];
  if (opts.warning) lines.push(`警告：${opts.warning}`);
  lines.push(
    `同步范围：${opts.include.length > 0 ? opts.include.join("、") : "（空，以后可以编辑 .kanban-hub/config.yaml）"}`,
  );
  lines.push("将要写入的文件：");
  lines.push(`  - ${repoConfigPathFor(opts.root)}`);
  lines.push(opts.excludePath ? `  - ${opts.excludePath}` : "  -（不是 git 仓库，跳过 info/exclude）");
  lines.push("将要调用的接口：");
  if (opts.action.kind === "new") lines.push("  - POST /api/v1/projects");
  lines.push("  - PUT /api/v1/projects/:id/locations/:machineId");
  return lines;
}

/** 打印计划；--dry-run 到此为止，否则按 --yes / 交互确认决定是否继续执行 */
async function confirmPlan(ctx: CliContext, opts: Pick<RegisterOptions, "dryRun" | "yes">, lines: string[]): Promise<boolean> {
  ctx.stdout.write(`${lines.join("\n")}\n`);
  if (opts.dryRun) return false;
  if (opts.yes) return true;
  if (!ctx.isTTY) {
    throw new CliError(EXIT.USAGE, "非交互环境下需要确认才能继续", "加上 --yes 跳过确认");
  }
  const proceed = await confirm(ctx, "是否执行以上计划？");
  if (!proceed) ctx.stdout.write("已取消。\n");
  return proceed;
}

function printRegistered(ctx: CliContext, project: Project, root: string): void {
  ctx.stdout.write(`项目：${project.name}（${project.id}）\n`);
  ctx.stdout.write(`本机位置：${root}\n`);
  ctx.stdout.write("可以执行 kh status 查看进度\n");
}

async function putLocation(
  client: ApiClient,
  projectId: string,
  machineId: string,
  root: string,
  sync: ReturnType<typeof toSyncScope>,
): Promise<Project> {
  // 请求体先过 core 的输入 schema，把能在本地发现的错误拦在本地（与 login 的做法一致）
  const parsed = locationInput.safeParse({ path: root, sync });
  if (!parsed.success) throw new CliError(EXIT.USAGE, formatZodError(parsed.error).join("；"));
  return client.put(`/api/v1/projects/${projectId}/locations/${machineId}`, parsed.data, projectSchema);
}

/** 仓库已经有配置：查项目，本机位置已登记且路径一致就到此为止，否则补登记本机位置 */
async function handleExistingConfig(
  ctx: CliContext,
  client: ApiClient,
  machine: { id: string; name: string },
  repo: RegisteredRepo,
  opts: RegisterOptions,
): Promise<void> {
  const detail = await loadProject(client, repo.config.projectId);
  const project = detail.project;
  const location = project.locations.find((l) => l.machineId === machine.id);

  if (location && location.path === repo.root) {
    printRegistered(ctx, project, repo.root);
    return;
  }

  const lines = [
    `仓库根：${repo.root}`,
    `动作：为项目 ${project.name}（${project.id}）补登记本机位置`,
    "将要调用的接口：",
    "  - PUT /api/v1/projects/:id/locations/:machineId",
  ];
  const proceed = await confirmPlan(ctx, opts, lines);
  if (!proceed) return;

  const sync = toSyncScope(repo.config);
  const updated = await putLocation(client, project.id, machine.id, repo.root, sync);
  printRegistered(ctx, updated, repo.root);
}

/** 决定绑定已有项目还是新建（规格 8.2 第 5 步） */
async function decideAction(
  client: ApiClient,
  opts: RegisterOptions,
  fp: string | null,
  matches: readonly ProjectView[],
): Promise<{ action: PlanAction; warning?: string }> {
  if (opts.bind !== undefined) {
    const all = await client.get("/api/v1/projects", projectListResponse);
    const project = resolveBindProject(all.projects, opts.bind);
    const warning =
      fp !== null && project.project.fingerprint !== fp
        ? `项目「${project.project.name}」登记的指纹与当前仓库不一致，仍会继续绑定`
        : undefined;
    return { action: { kind: "bind", project }, warning };
  }

  if (opts.new) {
    const warning = matches.length > 0 ? `当前仓库的指纹已经匹配到已有项目：${describeProjects(matches)}，仍会新建` : undefined;
    return { action: { kind: "new" }, warning };
  }

  if (matches.length === 1) return { action: { kind: "bind", project: matches[0]! } };
  if (matches.length === 0) return { action: { kind: "new" } };
  throw new CliError(EXIT.USAGE, "当前仓库的指纹匹配到多个项目，请用 --bind 指定其中一个", describeProjects(matches));
}

/** 没有仓库配置的全新注册流程（规格 8.2） */
async function registerFresh(
  ctx: CliContext,
  client: ApiClient,
  machine: { id: string; name: string },
  opts: RegisterOptions,
): Promise<void> {
  const inspection: RepoInspection = await inspectRepo(ctx.cwd);
  const root = inspection.root;
  const fp = inspection.isGit ? await fingerprint(root) : null;

  const matches =
    fp !== null ? (await client.get(`/api/v1/projects?fingerprint=${encodeURIComponent(fp)}`, projectListResponse)).projects : [];

  const { action, warning } = await decideAction(client, opts, fp, matches);

  const name = opts.name ?? defaultProjectName(root);

  let include: string[];
  if (opts.include !== undefined) {
    for (const glob of opts.include) validateSyncGlob(glob);
    include = opts.include;
  } else {
    include = await suggestSyncInclude(root);
  }

  const excludePlan = await planExclude(inspection);
  const planLines = buildPlanLines({
    root,
    fp,
    matches,
    action,
    name,
    include,
    excludePath: inspection.isGit ? excludePlan.path : null,
    warning,
  });

  const proceed = await confirmPlan(ctx, opts, planLines);
  if (!proceed) return;

  // 执行顺序（失败后重新执行的行为见任务简报“执行顺序与失败后的状态”）：
  // 1. 新建项目（--new 或自动新建时）；2. PUT 本机位置；3. ensureExcluded；4. writeRepoConfig。
  // 配置文件最后写，它存在就代表注册完成；前面任意一步失败都不留下本地文件。
  let project: Project;
  if (action.kind === "new") {
    const parsed = projectCreateInput.safeParse({ name, fingerprint: fp });
    if (!parsed.success) throw new CliError(EXIT.USAGE, formatZodError(parsed.error).join("；"));
    const created = await client.post("/api/v1/projects", parsed.data, projectCreatedResponse);
    project = created.project;
  } else {
    project = action.project.project;
  }

  const repoConfig: RepoConfig = {
    projectId: project.id,
    sync: { include, exclude: [], maxFileSize: formatByteSize(SYNC_DEFAULT_MAX_FILE_SIZE) },
    pull: { auto: true },
  };
  const sync = toSyncScope(repoConfig);
  const updated = await putLocation(client, project.id, machine.id, root, sync);

  await ensureExcluded(inspection);
  await writeRepoConfig(root, repoConfig);

  printRegistered(ctx, updated, root);
}

async function runRegister(ctx: CliContext, opts: RegisterOptions, agentFlag: string | undefined): Promise<void> {
  // 手动检查而不是用 commander 的 Option#conflicts()：conflicts() 在校验失败时调用的是子命令
  // 自身的 error()，而子命令的输出/退出配置只在 buildProgram 阶段 program.command() 创建它的
  // 那一刻从父命令复制一次（commander 15 的 copyInheritedSettings），main.ts 里 attachOutput()
  // 对根命令做的 exitOverride()/configureOutput() 发生在那之后，子命令拿不到，于是会真的调用
  // process.exit() 并把错误打到真实的 stderr，绕过本项目“不直接调用 process.exit”的约定。
  // 这里改成普通的 CliError，走 runProgram 的 try/catch，行为才可控。
  if (opts.bind !== undefined && opts.new) {
    throw new CliError(EXIT.USAGE, "--bind 与 --new 不能同时使用");
  }

  const { client, machine } = await requireLogin(ctx, agentFlag);

  const existing = await findRegisteredRepo(ctx.cwd, ctx);
  if (existing) {
    await handleExistingConfig(ctx, client, machine, existing, opts);
    return;
  }

  await registerFresh(ctx, client, machine, opts);
}

/** kh register：按规格 8.2 把当前仓库注册到 kanban-hub */
export function registerRegister(program: Command, ctx: CliContext): void {
  program
    .command("register")
    .description("把当前仓库注册到 kanban-hub")
    .option("--name <名称>", "项目名称，默认取仓库根目录的目录名")
    .option("--bind <项目ID或前缀>", "绑定到已有项目（完整 ID 或至少 4 位的前缀），不能与 --new 同时使用")
    .option("--new", "新建项目，即使指纹已经匹配到已有项目也新建，不能与 --bind 同时使用")
    .option("--include <glob>", "自定义同步范围（可重复传入），省略时按目录结构自动建议", collectInclude)
    .option("--dry-run", "只打印计划，不写入任何内容，也不会新建项目或登记位置")
    .option("--yes", "跳过交互确认")
    .action(async (opts: RegisterOptions, cmd: Command) => {
      await runRegister(ctx, opts, globalAgentFlag(cmd));
    });
}
