/**
 * kh conflicts / conflicts show / conflicts resolve：查看与解决拉取时登记的冲突。
 * 冲突记录和对方版本的内容都在本机缓存里，这几个命令不需要联网。
 * show 对仓库只读，差异按原始字节输出；resolve 在同步锁里执行，只有 --take-remote 会写仓库里的
 * 文件，而且与拉取一样只写同步范围内、没有被 git 跟踪、路径安全的文件。
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import { looksBinary, rememberSeen } from "@kanban-hub/core/pull";
import { resolveAgent } from "../agent";
import type { CliContext } from "../context";
import { CliError, EXIT } from "../errors";
import { formatByteSize, toSyncScope } from "../repo/config";
import { toRepoPath, type RegisteredRepo } from "../repo/root";
import { inspectLocalPath, LocalChangedError, writeLocalFile } from "../sync/local";
import { withSyncLock } from "../sync/lock";
import { diff3Text, diffNoIndex } from "../sync/merge";
import { isReservedPath, listTrackedPaths } from "../sync/pull";
import { assertValidScope } from "../sync/push";
import { createSyncScopeMatcher } from "../sync/scan";
import { openSyncState, type ConflictRecord, type SyncState } from "../sync/state";
import { formatUpdatedAt } from "./docs";
import { globalAgentFlag, requireRegisteredRepo, withAgentOption } from "./shared";

const LOCAL_LABEL = "本机";
const BASE_LABEL = "共同基准";
const SYNC_HINT = "下一步：执行 kh sync 推送最终内容";

type ResolveMode = "edited" | "take-local" | "take-remote";

interface ResolveOptions {
  edited?: boolean;
  takeLocal?: boolean;
  takeRemote?: boolean;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function machineLabel(record: ConflictRecord): string {
  return record.remoteMachineName ?? record.remoteMachineId;
}

/** --agent 在这几个命令里不发请求，只校验写法，保持与其他命令一致的用法错误 */
function checkAgent(ctx: CliContext, cmd: Command): void {
  resolveAgent(globalAgentFlag(cmd), ctx.env);
}

/**
 * 找到冲突记录：先按原样当作仓库内路径查，查不到再按相对于当前目录的路径换算一次。
 * 路径没有未解决的冲突时是用法错误（退出码 2）。
 */
function findConflict(ctx: CliContext, repo: RegisteredRepo, state: SyncState, input: string): { relPath: string; record: ConflictRecord } {
  const direct = state.conflicts.get(input);
  if (direct !== undefined) return { relPath: input, record: direct };
  let relPath: string | null = null;
  try {
    relPath = toRepoPath(repo.root, ctx.cwd, input);
  } catch {
    relPath = null;
  }
  const record = relPath !== null ? state.conflicts.get(relPath) : undefined;
  if (relPath === null || record === undefined) {
    throw new CliError(EXIT.USAGE, `这个路径没有未解决的冲突：${input}`, "执行 kh conflicts 查看全部冲突");
  }
  return { relPath, record };
}

async function requireRemoteBlob(state: SyncState, relPath: string, record: ConflictRecord): Promise<Uint8Array> {
  const bytes = await state.readBlob(record.remoteSha);
  if (bytes === null || sha256Hex(bytes) !== record.remoteSha) {
    throw new CliError(
      EXIT.UNEXPECTED,
      `本机缓存里找不到对方版本的内容：${relPath}`,
      `执行 kh conflicts resolve ${relPath} --take-local 保留本机版本后，重新执行 kh pull`,
    );
  }
  return bytes;
}

async function runList(ctx: CliContext): Promise<void> {
  const repo = await requireRegisteredRepo(ctx);
  const state = await openSyncState(ctx, repo.config.projectId, repo.root);
  const entries = [...state.conflicts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0) {
    ctx.stdout.write("没有未解决的冲突\n");
    return;
  }
  const lines = entries.map(([p, record]) => `${p}\t${machineLabel(record)}\t${formatUpdatedAt(record.detectedAt)}`);
  ctx.stdout.write(`${lines.join("\n")}\n`);
  ctx.stdout.write(`下一步：执行 kh conflicts show ${entries[0]![0]} 查看差异\n`);
}

async function runShow(ctx: CliContext, input: string): Promise<void> {
  const repo = await requireRegisteredRepo(ctx);
  const state = await openSyncState(ctx, repo.config.projectId, repo.root);
  const { relPath, record } = findConflict(ctx, repo, state, input);
  const remote = await requireRemoteBlob(state, relPath, record);
  const local = await inspectLocalPath(repo.root, relPath);

  if (local.kind !== "file") {
    const reason = local.kind === "absent" ? "本地文件已不存在" : `本地路径不是普通文件（${local.reason}）`;
    const lines = [
      `${reason}：${relPath}`,
      `对方版本：来自 ${machineLabel(record)}，${formatByteSize(remote.length)}，sha256 ${record.remoteSha.slice(0, 12)}，登记于 ${formatUpdatedAt(record.detectedAt)}`,
      `可以执行 kh conflicts resolve ${relPath} --take-remote 采用对方版本，或 --take-local 保留本机现状`,
    ];
    ctx.stdout.write(`${lines.join("\n")}\n`);
    return;
  }

  const localBytes = await fs.readFile(local.absPath);
  const baseBytes = record.baseSha !== null ? await state.readBlob(record.baseSha) : null;
  if (baseBytes !== null && !looksBinary(localBytes) && !looksBinary(remote) && !looksBinary(baseBytes)) {
    const merged = await diff3Text(ctx, localBytes, baseBytes, remote, {
      local: LOCAL_LABEL,
      base: BASE_LABEL,
      remote: machineLabel(record),
    });
    ctx.stdout.write(merged);
    return;
  }

  // 二进制或没有基准内容：把对方内容写到系统临时目录，与本地文件做双方差异
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kh-conflict-"));
  try {
    const remotePath = path.join(dir, path.posix.basename(relPath));
    await fs.writeFile(remotePath, remote);
    ctx.stdout.write(await diffNoIndex(ctx, local.absPath, remotePath));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function parseResolveMode(opts: ResolveOptions): ResolveMode {
  const chosen: ResolveMode[] = [];
  if (opts.edited) chosen.push("edited");
  if (opts.takeLocal) chosen.push("take-local");
  if (opts.takeRemote) chosen.push("take-remote");
  if (chosen.length !== 1) {
    throw new CliError(EXIT.USAGE, "请在 --edited、--take-local、--take-remote 里选择一种（只能选一种）");
  }
  return chosen[0]!;
}

const MODE_TEXT: Record<ResolveMode, string> = {
  edited: "已手动编辑",
  "take-local": "保留本机版本",
  "take-remote": "采用对方版本",
};

async function runResolve(ctx: CliContext, input: string, mode: ResolveMode): Promise<void> {
  const repo = await requireRegisteredRepo(ctx);
  const projectId = repo.config.projectId;

  const relPath = await withSyncLock(ctx, projectId, async () => {
    const state = await openSyncState(ctx, projectId, repo.root);
    const { relPath, record } = findConflict(ctx, repo, state, input);
    const local = await inspectLocalPath(repo.root, relPath);
    let finalSha: string | null = null;

    if (mode === "edited") {
      if (local.kind !== "file") {
        throw new CliError(EXIT.USAGE, `本地文件不存在或不是普通文件：${relPath}`, "改成最终内容后再执行，或者改用 --take-remote / --take-local");
      }
      finalSha = sha256Hex(await fs.readFile(local.absPath));
    } else if (mode === "take-local") {
      if (local.kind === "file") finalSha = sha256Hex(await fs.readFile(local.absPath));
    } else {
      assertValidScope(repo.config);
      if (!createSyncScopeMatcher(toSyncScope(repo.config))(relPath)) {
        throw new CliError(
          EXIT.DATA,
          `路径不在本机的同步范围内，不写入：${relPath}`,
          "先调整 .kanban-hub/config.yaml 里的同步范围，或者改用 --take-local",
        );
      }
      const remote = await requireRemoteBlob(state, relPath, record);
      const isTracked = await listTrackedPaths(ctx, repo.root);
      if (isTracked(relPath) || isReservedPath(relPath) || local.kind === "unsafe") {
        throw new CliError(EXIT.DATA, `路径被 git 跟踪或不安全，不写入：${relPath}`, "改用 --edited 或 --take-local");
      }
      try {
        const written = await writeLocalFile(repo.root, relPath, remote, local);
        state.recordHash(relPath, written.size, written.mtimeMs, record.remoteSha);
      } catch (err) {
        if (err instanceof LocalChangedError) throw new CliError(EXIT.DATA, err.message, "请重试");
        throw err;
      }
      finalSha = record.remoteSha;
    }

    // 三种方式都一样：基准取对方版本，对方内容与本地最终内容都记为见过，删除冲突记录
    state.base.set(relPath, record.remoteSha);
    const shas = finalSha !== null && finalSha !== record.remoteSha ? [record.remoteSha, finalSha] : [record.remoteSha];
    state.seen.set(relPath, rememberSeen(state.seen.get(relPath) ?? [], ...shas));
    state.conflicts.delete(relPath);
    await state.gcBlobs();
    await state.save();
    return relPath;
  });

  ctx.stdout.write(`已解决冲突：${relPath}（${MODE_TEXT[mode]}）\n${SYNC_HINT}\n`);
}

/** kh conflicts：列出、查看、解决拉取时登记的冲突（规格 9.3） */
export function registerConflicts(program: Command, ctx: CliContext): void {
  const conflicts = withAgentOption(program.command("conflicts").description("列出未解决的冲突；show 查看差异，resolve 标记已解决"));
  conflicts.action(async (_opts: unknown, cmd: Command) => {
    checkAgent(ctx, cmd);
    await runList(ctx);
  });

  withAgentOption(
    conflicts
      .command("show")
      .description("输出冲突的差异，不改本地文件：文本用三方合并标记，二进制或没有基准时用 git diff")
      .argument("<路径>", "仓库内相对路径"),
  ).action(async (filePath: string, _opts: unknown, cmd: Command) => {
    checkAgent(ctx, cmd);
    await runShow(ctx, filePath);
  });

  withAgentOption(
    conflicts
      .command("resolve")
      .description("标记冲突已解决，基准更新为对方版本")
      .argument("<路径>", "仓库内相对路径")
      .option("--edited", "本地文件已经改成最终内容")
      .option("--take-local", "保留本机版本")
      .option("--take-remote", "用对方版本覆盖本地"),
  ).action(async (filePath: string, opts: ResolveOptions, cmd: Command) => {
    checkAgent(ctx, cmd);
    await runResolve(ctx, filePath, parseResolveMode(opts));
  });
}
