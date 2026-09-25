import path from "node:path";
import { Command } from "commander";
import type { z } from "zod";
import { projectCreatedResponse, projectListResponse, type ProjectView } from "@kanban-hub/core/api";
import { formatZodError } from "@kanban-hub/core/errors";
import { locationInput, projectCreateInput, projectSchema, type Project } from "@kanban-hub/core/schema";
import { SYNC_DEFAULT_MAX_FILE_SIZE } from "@kanban-hub/core/sync";
import type { CliContext } from "../context";
import { resolveKhHome } from "../config/home";
import { CliError, EXIT } from "../errors";
import type { ApiClient } from "../http/client";
import { confirm } from "../prompt";
import { readRepoConfig, formatByteSize, toSyncScope, writeRepoConfig, type RepoConfig } from "../repo/config";
import { planExclude, ensureExcluded } from "../repo/exclude";
import { fingerprint } from "../repo/fingerprint";
import { collidesWithKhHome, findRegisteredRepoInGit, inspectRepo, type RegisteredRepo, type RepoInspection } from "../repo/root";
import { suggestSyncInclude, validateSyncGlob } from "../repo/scope";
import { globalAgentFlag, loadProjectOrFail, requireLogin, withAgentOption } from "./shared";

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

/** 项目名默认取仓库根目录的目录名 */
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

/** 指纹的展示文案：区分“不是 git 仓库”和“是 git 仓库但还没有提交”这两种指纹为空的情况 */
function fingerprintLabel(isGit: boolean, fp: string | null): string {
  if (fp !== null) return fp;
  return isGit ? "无（仓库还没有提交）" : "无（不是 git 仓库）";
}

function buildPlanLines(opts: {
  root: string;
  isGit: boolean;
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
    `指纹：${fingerprintLabel(opts.isGit, opts.fp)}`,
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

/**
 * 仓库已经有配置时，显式参数不能被静默忽略：
 * - --new 与已有配置冲突，直接报用法错误，不建议删配置之外的绕过办法；
 * - --bind 给了但和配置里的 projectId 不一致，同样是用法错误——配置文件说了算，
 *   要绑定别的项目得先删掉配置文件重新走一遍全新注册；
 * - --include / --name 在这个分支完全不生效，计划里要写一行说明，不能什么都不提。
 */
function assertNoConflictingOptions(repo: RegisteredRepo, opts: RegisterOptions): void {
  if (opts.new) {
    throw new CliError(
      EXIT.USAGE,
      `仓库已注册到 ${repo.config.projectId}`,
      "如需重新注册，先删除 .kanban-hub/config.yaml",
    );
  }
  if (opts.bind !== undefined) {
    const ref = opts.bind.trim().toLowerCase();
    if (!repo.config.projectId.toLowerCase().startsWith(ref)) {
      throw new CliError(
        EXIT.USAGE,
        `--bind ${opts.bind} 与仓库已登记的项目（${repo.config.projectId}）不一致`,
        "如需改绑其他项目，先删除 .kanban-hub/config.yaml",
      );
    }
  }
}

/** 仓库已经有配置：查项目，本机位置已登记且路径一致就到此为止，否则补登记本机位置 */
async function handleExistingConfig(
  ctx: CliContext,
  client: ApiClient,
  machine: { id: string; name: string },
  repo: RegisteredRepo,
  opts: RegisterOptions,
): Promise<void> {
  assertNoConflictingOptions(repo, opts);

  // 项目在服务端不存在（配置文件被人搬到了另一台服务端，或者项目已被删除）时，
  // 复用 status 在同样情况下的提示：多半是 .kanban-hub/config.yaml 里的 projectId 不对
  const detail = await loadProjectOrFail(client, repo.config.projectId);
  const project = detail.project;
  const location = project.locations.find((l) => l.machineId === machine.id);

  if (location && location.path === repo.root) {
    printRegistered(ctx, project, repo.root);
    return;
  }

  const ignoredOptionNotes: string[] = [];
  if (opts.include !== undefined) {
    ignoredOptionNotes.push("已有配置，--include 不生效，同步范围以 .kanban-hub/config.yaml 为准");
  }
  if (opts.name !== undefined) {
    ignoredOptionNotes.push("已有配置，--name 不生效，项目名称以服务端为准");
  }

  const lines = [
    `仓库根：${repo.root}`,
    `动作：为项目 ${project.name}（${project.id}）补登记本机位置`,
    `本机原有位置：${location ? location.path : "无"}`,
    `本机新位置：${repo.root}`,
    ...ignoredOptionNotes,
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
  inspection: RepoInspection,
): Promise<void> {
  const root = inspection.root;
  const fp = inspection.isGit ? await fingerprint(root) : null;

  const matches =
    fp !== null ? (await client.get(`/api/v1/projects?fingerprint=${encodeURIComponent(fp)}`, projectListResponse)).projects : [];

  const { action, warning } = await decideAction(client, opts, fp, matches);

  const name = opts.name ?? defaultProjectName(root);

  // 名称在打印计划之前就要校验：--dry-run 也要能发现非法名称，不能等用户确认之后才失败
  let createInput: z.output<typeof projectCreateInput> | undefined;
  if (action.kind === "new") {
    const parsed = projectCreateInput.safeParse({ name, fingerprint: fp });
    if (!parsed.success) throw new CliError(EXIT.USAGE, formatZodError(parsed.error).join("；"));
    createInput = parsed.data;
  }

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
    isGit: inspection.isGit,
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

  // 执行顺序：1. 新建项目（--new 或自动新建时）；2. PUT 本机位置；3. ensureExcluded；
  // 4. writeRepoConfig。配置文件最后写，它存在就代表注册完成。
  let project: Project;
  if (action.kind === "new") {
    // createInput 在 action.kind === "new" 分支上面已经赋值过，这里不会是 undefined
    const created = await client.post("/api/v1/projects", createInput!, projectCreatedResponse);
    project = created.project;
  } else {
    project = action.project.project;
  }

  // 项目建好之后，第 2-4 步任何一步失败都不能悄无声息：agent 很可能原样重试 --new --yes，
  // 那样会把同一个仓库重复建成两个项目（服务端没有删除项目的途径，只能归档）。这里把失败
  // 包成同样退出码的 CliError，hint 告诉重试时改用 --bind 绑定刚建好的项目。
  try {
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
  } catch (err) {
    if (action.kind !== "new") throw err;
    const hint = `项目已新建：${project.name}（${project.id}）。重新执行时请改用 kh register --bind ${project.id} --yes，避免重复新建`;
    if (err instanceof CliError) throw new CliError(err.exitCode, err.message, hint);
    const message = err instanceof Error ? err.message : String(err);
    throw new CliError(EXIT.UNEXPECTED, message, hint);
  }
}

/** register 用的仓库根不能是 KH_HOME 所在的目录：那个目录下的 .kanban-hub 是本机配置，不是仓库配置 */
function assertRootNotKhHome(root: string, ctx: CliContext): void {
  if (!collidesWithKhHome(root, ctx)) return;
  const khHome = resolveKhHome(ctx);
  throw new CliError(
    EXIT.USAGE,
    "不能把本机配置目录所在的目录注册为仓库",
    `本机配置目录是 ${khHome}，请在其他目录执行 kh register`,
  );
}

/**
 * register 用的仓库根：git 仓库取 show-toplevel，否则取当前目录。判断“已有配置”时：
 * - git 仓库沿用 findRegisteredRepoInGit（show-toplevel 优先，链接工作树时退回主工作树根）——
 *   主工作树已经注册的话，在链接工作树里执行 register 要能看到这个事实，不能因为看不到就
 *   走全新注册，按指纹绑定同一个项目后又用工作树自己的路径覆盖本机在主工作树上的位置；
 * - 非 git 目录只看当前这一层，不往上找，否则在已注册目录的子目录里执行 --new 会被父项目的
 *   配置吞掉（非 git 目录没有“顶层”的概念，没有对应的“不越过顶层”这道天然边界）。
 */
async function findExistingConfigForRegister(inspection: RepoInspection, ctx: CliContext): Promise<RegisteredRepo | null> {
  if (inspection.isGit) return findRegisteredRepoInGit(inspection, ctx);
  const config = await readRepoConfig(inspection.root);
  return config !== null ? { root: inspection.root, config } : null;
}

async function runRegister(ctx: CliContext, opts: RegisterOptions, agentFlag: string | undefined): Promise<void> {
  // 不用 commander 的 Option#conflicts()：这里改成普通的 CliError，走 runProgram 统一的
  // try/catch，输出格式和退出码与其余用法错误保持一致。
  if (opts.bind !== undefined && opts.new) {
    throw new CliError(EXIT.USAGE, "--bind 与 --new 不能同时使用");
  }

  const { client, machine } = await requireLogin(ctx, agentFlag);

  const inspection = await inspectRepo(ctx.cwd);
  assertRootNotKhHome(inspection.root, ctx);

  const existing = await findExistingConfigForRegister(inspection, ctx);
  if (existing !== null) {
    await handleExistingConfig(ctx, client, machine, existing, opts);
    return;
  }

  await registerFresh(ctx, client, machine, opts, inspection);
}

/** kh register：按规格 8.2 把当前仓库注册到 kanban-hub */
export function registerRegister(program: Command, ctx: CliContext): void {
  withAgentOption(
    program
      .command("register")
      .description("把当前仓库注册到 kanban-hub")
      .option("--name <名称>", "项目名称，默认取仓库根目录的目录名")
      .option("--bind <项目ID或前缀>", "绑定到已有项目（完整 ID 或至少 4 位的前缀），不能与 --new 同时使用")
      .option("--new", "新建项目，即使指纹已经匹配到已有项目也新建，不能与 --bind 同时使用")
      .option("--include <glob>", "自定义同步范围（可重复传入），省略时按目录结构自动建议", collectInclude)
      .option("--dry-run", "只打印计划，不写入任何内容，也不会新建项目或登记位置")
      .option("--yes", "跳过交互确认"),
  ).action(async (opts: RegisterOptions, cmd: Command) => {
    await runRegister(ctx, opts, globalAgentFlag(cmd));
  });
}
