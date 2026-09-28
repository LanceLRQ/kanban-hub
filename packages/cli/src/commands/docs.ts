/**
 * kh docs ls / kh docs cat：只读地浏览其他机器同步过来的文档，本机仓库不会被写入。
 */
import type { Command } from "commander";
import picomatch from "picomatch";
import type { ManifestFile } from "@kanban-hub/core/sync";
import { looksBinary } from "@kanban-hub/core/pull";
import { snapshotPathSchema } from "@kanban-hub/core/sync";
import type { CliContext } from "../context";
import { CliError, EXIT } from "../errors";
import type { ApiClient } from "../http/client";
import { formatByteSize } from "../repo/config";
import { fetchLatestRemote, fetchMachineManifest, fetchRemoteFile, resolveMachineRef } from "../sync/remote";
import { globalAgentFlag, requireLogin, requireRegisteredRepo, withAgentOption } from "./shared";

interface DocsOptions {
  from?: string;
}

type RemoteFile = ManifestFile & { machineId: string };

interface ResolvedRemoteFiles {
  files: RemoteFile[];
  nameOf(machineId: string): string;
}

const NO_OTHER_MACHINE_HINT = "在另一台机器上执行 kh sync 后再试";

/**
 * 按 --from 决定用哪台机器的清单：给了 --from 就取那一台机器自己的清单；否则取除本机之外
 * 每个路径的最新版本。没有 --from 且其他机器都没有同步过时，退出码 5（规格第 15 节）。
 */
async function resolveRemoteFiles(
  client: ApiClient,
  projectId: string,
  selfMachineId: string,
  from: string | undefined,
): Promise<ResolvedRemoteFiles> {
  if (from !== undefined) {
    const latest = await fetchLatestRemote(client, projectId, null);
    const target = resolveMachineRef(from, latest.machines);
    const manifest = await fetchMachineManifest(client, projectId, target.id);
    const files = manifest.files.map((file) => ({ ...file, machineId: target.id }));
    const name = manifest.machineName || target.name;
    return { files, nameOf: () => name };
  }

  const latest = await fetchLatestRemote(client, projectId, selfMachineId);
  // machines 列表来自服务端汇总，本机自己也会出现在里面（latest-manifest 只在 files 里排除本机，
  // 不在 machines 里排除）；这里要判断的是“除了本机还有没有别的机器同步过”，不能直接看整个列表是否为空
  const others = latest.machines.filter((m) => m.id !== selfMachineId);
  if (others.length === 0) {
    throw new CliError(EXIT.DATA, "其他机器还没有同步过这个项目的文档", NO_OTHER_MACHINE_HINT);
  }
  const nameById = new Map<string, string>(latest.machines.map((m) => [m.id, m.name]));
  return { files: latest.files, nameOf: (machineId: string) => nameById.get(machineId) ?? machineId };
}

/** 与 M4 一致的做法：按本机时区格式化，时区可以注入（测试用） */
function formatUpdatedAt(iso: string, timeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

async function runDocsLs(ctx: CliContext, glob: string | undefined, opts: DocsOptions, agentFlag: string | undefined): Promise<void> {
  const repo = await requireRegisteredRepo(ctx);
  const { client, machine } = await requireLogin(ctx, agentFlag);
  const { files, nameOf } = await resolveRemoteFiles(client, repo.config.projectId, machine.id, opts.from);

  let selected = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (glob !== undefined) {
    const isMatch = picomatch(glob, { dot: true });
    selected = selected.filter((file) => isMatch(file.path));
  }

  if (selected.length === 0) {
    ctx.stdout.write("没有匹配的文件\n");
    return;
  }

  const lines = selected.map(
    (file) => `${file.path}\t${formatByteSize(file.size)}\t${formatUpdatedAt(file.changedAt)}\t${nameOf(file.machineId)}`,
  );
  ctx.stdout.write(`${lines.join("\n")}\n`);
}

async function runDocsCat(ctx: CliContext, rawPath: string, opts: DocsOptions, agentFlag: string | undefined): Promise<void> {
  const parsedPath = snapshotPathSchema.safeParse(rawPath);
  if (!parsedPath.success) {
    throw new CliError(EXIT.USAGE, `不是合法的仓库内相对路径：${rawPath}`);
  }
  const filePath = parsedPath.data;

  const repo = await requireRegisteredRepo(ctx);
  const { client, machine } = await requireLogin(ctx, agentFlag);
  const { files } = await resolveRemoteFiles(client, repo.config.projectId, machine.id, opts.from);

  const found = files.find((file) => file.path === filePath);
  if (!found) {
    throw new CliError(EXIT.DATA, `文件不在快照中：${filePath}`);
  }

  const bytes = await fetchRemoteFile(client, repo.config.projectId, found.machineId, filePath);
  if (looksBinary(bytes)) {
    throw new CliError(EXIT.DATA, `二进制文件，无法在终端显示：${filePath}`, "请到网页查看");
  }
  ctx.stdout.write(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
}

/** kh docs ls / kh docs cat：只读地浏览其他机器同步过来的文档（规格第 9、15 节） */
export function registerDocs(program: Command, ctx: CliContext): void {
  const docs = program.command("docs").description("浏览其他机器同步过来的文档（只读）");

  withAgentOption(
    docs
      .command("ls")
      .description("列出文档：路径、大小、更新时间、来自哪台机器")
      .argument("[glob]", "按 glob 过滤路径")
      .option("--from <机器>", "只看某一台机器（机器名或 ID 前缀），省略时取每个路径的最新版本"),
  ).action(async (glob: string | undefined, opts: DocsOptions, cmd: Command) => {
    await runDocsLs(ctx, glob, opts, globalAgentFlag(cmd));
  });

  withAgentOption(
    docs
      .command("cat")
      .description("把文档内容原样打印到标准输出")
      .argument("<路径>", "仓库内相对路径")
      .option("--from <机器>", "只看某一台机器（机器名或 ID 前缀），省略时取该路径的最新版本"),
  ).action(async (filePath: string, opts: DocsOptions, cmd: Command) => {
    await runDocsCat(ctx, filePath, opts, globalAgentFlag(cmd));
  });
}
