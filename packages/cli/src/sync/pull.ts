/**
 * kh pull 的核心逻辑：把其他机器的文档版本按逐文件规则安全地写到本地。kh pull 本身和
 * M6 的 SessionStart hook（带 deadline 限时）都调用 pullDocs，命令行外壳只负责取仓库配置、
 * 登录态和渲染输出。
 *
 * 对被管理仓库的写入只发生在这里（以及 kh conflicts resolve --take-remote）：
 * - 只写同步范围内、没有被 git 跟踪的文件；从不删除本地文件；
 * - 写之前逐级确认路径在仓库根内、没有软链接，只在确认上一级安全之后才建目录（见 local.ts）；
 * - 逐文件原子写入，每写完一个文件就更新内存里的状态，结束（包括出错、超时）时保存一次。
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import picomatch from "picomatch";
import { z } from "zod";
import type { PullReportInput } from "@kanban-hub/core/api";
import { decidePull, looksBinary, rememberSeen } from "@kanban-hub/core/pull";
import { validateSyncGlob, type RemoteFile } from "@kanban-hub/core/sync";
import { loginHint, readMachineConfig, resolveKhHome } from "../config/home";
import type { CliContext } from "../context";
import { CliError, EXIT } from "../errors";
import { isNoEntError, KH_TMP_PATTERN } from "../fs-utils";
import type { ApiClient } from "../http/client";
import { REPO_CONFIG_DIR, toSyncScope } from "../repo/config";
import type { RegisteredRepo } from "../repo/root";
import { listTrackedPaths, pathKey } from "./git-state";
import { inspectLocalPath, LocalChangedError, writeLocalFile, type LocalEntry } from "./local";
import { withSyncLock } from "./lock";
import { mergeText } from "./merge";
import { assertValidScope } from "./push";
import { fetchLatestRemote, fetchMachineManifest, fetchRemoteFile, resolveMachineRef } from "./remote";
import { createSyncScopeMatcher } from "./scan";
import { openSyncState, type SyncState } from "./state";

export interface PullOptions {
  /** 只看这台机器（机器名或 ID 前缀）；省略时每个路径取其他机器里最新的版本 */
  from?: string;
  /** 只处理匹配这个 glob 的路径 */
  pathGlob?: string;
  /** 只判定、不写任何东西：不加锁、不写仓库、不写 KH_HOME */
  dryRun: boolean;
  /** 毫秒时间戳：到时间后不再处理下一个文件，结果的 timedOut 为 true */
  deadline?: number;
}

export interface PullResult {
  created: string[];
  overwritten: string[];
  merged: string[];
  conflicts: string[];
  stale: string[];
  skippedTracked: string[];
  skippedUnsafe: string[];
  /** 下载到的对方内容与清单记的不一致（对方在拉取过程中又同步了新版本），这次跳过 */
  skippedChanged: string[];
  timedOut: boolean;
  fromMachineIds: string[];
}

interface RemoteSelection {
  files: RemoteFile[];
  nameOf(machineId: string): string;
}

const NO_OTHER_MACHINE_HINT = "在另一台机器上执行 kh sync 后再试";

const okResponse = z.object({ ok: z.literal(true) });

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function requireSelfMachineId(ctx: CliContext): Promise<string> {
  const cfg = await readMachineConfig(resolveKhHome(ctx));
  if (!cfg?.machineId) throw new CliError(EXIT.AUTH, "尚未登录", loginHint(cfg?.server));
  return cfg.machineId;
}

/**
 * 取对方清单：给了 from 就用那台机器自己的清单，否则用除本机之外每个路径的最新版本。
 * 其他机器都没有同步过，或者对方清单里没有任何文件，都是退出码 5。
 */
async function selectRemote(
  client: ApiClient,
  projectId: string,
  selfId: string,
  from: string | undefined,
): Promise<RemoteSelection> {
  if (from !== undefined) {
    const latest = await fetchLatestRemote(client, projectId, null);
    const names = new Map(latest.machines.map((m) => [m.id, m.name]));
    const target = resolveMachineRef(
      from,
      latest.machines.filter((m) => m.id !== selfId),
    );
    const manifest = await fetchMachineManifest(client, projectId, target.id);
    if (manifest.files.length === 0) {
      throw new CliError(EXIT.DATA, `${target.name} 的快照里没有文件`, NO_OTHER_MACHINE_HINT);
    }
    return {
      files: manifest.files.map((file) => ({ ...file, machineId: target.id })),
      nameOf: (id) => names.get(id) ?? id,
    };
  }

  const latest = await fetchLatestRemote(client, projectId, selfId);
  // latest-manifest 只在 files 里排除本机，machines 里仍有本机，要单独过滤
  const others = latest.machines.filter((m) => m.id !== selfId);
  if (others.length === 0 || latest.files.length === 0) {
    throw new CliError(EXIT.DATA, "其他机器还没有同步过这个项目的文档", NO_OTHER_MACHINE_HINT);
  }
  const names = new Map(latest.machines.map((m) => [m.id, m.name]));
  return { files: latest.files, nameOf: (id) => names.get(id) ?? id };
}

/** kh 自己管理的路径与临时文件：无论对方快照里有没有，都不往本地写 */
export function isReservedPath(relPath: string): boolean {
  const first = relPath.split("/")[0]!.toLowerCase();
  if (first === REPO_CONFIG_DIR.toLowerCase()) return true;
  return KH_TMP_PATTERN.test(path.posix.basename(relPath));
}

/** decidePull 给的 nextBase 是不是“改成这份内容”（而不是保持不变或清空） */
function isNewBase(nextBase: string | null | "keep"): nextBase is string {
  return nextBase !== null && nextBase !== "keep";
}

class PullRun {
  readonly result: PullResult = {
    created: [],
    overwritten: [],
    merged: [],
    conflicts: [],
    stale: [],
    skippedTracked: [],
    skippedUnsafe: [],
    skippedChanged: [],
    timedOut: false,
    fromMachineIds: [],
  };
  private readonly used = new Set<string>();
  /** 本次已经处理过的路径（按 pathKey）：两台机器的快照里只差大小写或规范化形式的路径，第二个不再处理 */
  private readonly handled = new Set<string>();

  constructor(
    private readonly ctx: CliContext,
    private readonly root: string,
    private readonly client: ApiClient,
    private readonly projectId: string,
    private readonly state: SyncState,
    private readonly isTracked: (relPath: string) => boolean,
    private readonly nameOf: (machineId: string) => string,
    private readonly dryRun: boolean,
  ) {}

  finish(): PullResult {
    this.result.fromMachineIds = [...this.used].sort();
    return this.result;
  }

  /** 记下这台机器的内容被实际取用了（新建、覆盖、自动合并、登记冲突） */
  private use(file: RemoteFile): void {
    this.used.add(file.machineId);
  }

  private remember(relPath: string, ...shas: string[]): void {
    this.state.seen.set(relPath, rememberSeen(this.state.seen.get(relPath) ?? [], ...shas));
  }

  /**
   * 把基准改成 sha；内容另存一份 blob 供之后三方合并用。已经是这份基准时不重复写。
   * 基准被更新为对方的当前内容（新建、覆盖、两边相同、自动合并）时，这个路径的推送历史随之清空：
   * 之后以新基准为共同起点。采纳对方给的旧版本（stale）不算前进，传 keepPushed 保留推送历史
   */
  private async adoptBase(relPath: string, sha: string, bytes: Uint8Array, opts: { keepPushed?: boolean } = {}): Promise<void> {
    if (this.state.base.get(relPath) === sha) return;
    await this.state.putBlob(sha, bytes);
    this.state.base.set(relPath, sha);
    if (!opts.keepPushed) this.state.pushed.delete(relPath);
  }

  /**
   * 对方推送时的基准是不是本机推送过、而且缓存里还留有内容的版本。只是本机缓存：探测出错时
   * 按“没有内容”处理（退回本机基准或登记冲突），不让整次拉取失败
   */
  private async remoteBaseStored(relPath: string, remoteBase: string | null, seen: readonly string[]): Promise<boolean> {
    if (remoteBase === null || !seen.includes(remoteBase)) return false;
    if (!(this.state.pushed.get(relPath) ?? []).includes(remoteBase)) return false;
    try {
      return await this.state.hasBlob(remoteBase);
    } catch {
      return false;
    }
  }

  /**
   * 下载对方内容，并核对它就是清单里记的那一份。对不上说明对方在拉取过程中又同步了新版本：
   * 只跳过这个文件（记入 skippedChanged）、返回 null，不中止整次拉取；网络错误等其他失败照常抛出。
   */
  private async fetchRemote(file: RemoteFile): Promise<Uint8Array | null> {
    const bytes = await fetchRemoteFile(this.client, this.projectId, file.machineId, file.path);
    if (sha256Hex(bytes) !== file.sha256) {
      this.result.skippedChanged.push(file.path);
      return null;
    }
    return bytes;
  }

  /** 读本地内容，并核对它仍是判定时算出的 hash；对不上或者文件刚被删掉，都说明本地刚被改过，返回 null */
  private async readLocal(entry: Extract<LocalEntry, { kind: "file" }>, expectedSha: string): Promise<Uint8Array | null> {
    let bytes: Uint8Array;
    try {
      bytes = await fs.readFile(entry.absPath);
    } catch (err) {
      if (isNoEntError(err)) return null;
      throw err;
    }
    return sha256Hex(bytes) === expectedSha ? bytes : null;
  }

  /** 原子写入并把新的 size、mtime、hash 记进 hash 缓存；复查没通过时记为不安全、不写入 */
  private async write(
    relPath: string,
    bytes: Uint8Array,
    expected: Exclude<LocalEntry, { kind: "unsafe" }>,
  ): Promise<boolean> {
    try {
      const written = await writeLocalFile(this.root, relPath, bytes, expected);
      this.state.recordHash(relPath, written.size, written.mtimeMs, sha256Hex(bytes));
      return true;
    } catch (err) {
      if (err instanceof LocalChangedError) {
        this.result.skippedUnsafe.push(relPath);
        return false;
      }
      throw err;
    }
  }

  /** 登记冲突；dry-run 时不写任何东西，remoteBytes 可以为 null（不需要下载对方内容） */
  private async registerConflict(file: RemoteFile, remoteBytes: Uint8Array | null, baseSha: string | null): Promise<void> {
    if (!this.dryRun && remoteBytes !== null) {
      await this.state.putBlob(file.sha256, remoteBytes);
      this.state.conflicts.set(file.path, {
        remoteSha: file.sha256,
        remoteMachineId: file.machineId,
        remoteMachineName: this.nameOf(file.machineId),
        baseSha,
        detectedAt: this.ctx.now().toISOString(),
      });
    }
    this.result.conflicts.push(file.path);
    this.use(file);
  }

  async process(file: RemoteFile): Promise<void> {
    const relPath = file.path;
    const key = pathKey(relPath);
    if (this.handled.has(key) || isReservedPath(relPath)) {
      this.result.skippedUnsafe.push(relPath);
      return;
    }
    this.handled.add(key);

    const tracked = this.isTracked(relPath);
    const pendingConflict = this.state.conflicts.has(relPath);
    const local: LocalEntry = tracked || pendingConflict ? { kind: "absent" } : await inspectLocalPath(this.root, relPath);
    const localSha =
      local.kind === "file"
        ? await this.state.hashOf({ path: relPath, size: local.size, mtimeMs: local.mtimeMs, absPath: local.absPath })
        : null;
    const base = this.state.base.get(relPath) ?? null;
    const seen = this.state.seen.get(relPath) ?? [];
    const pushed = this.state.pushed.get(relPath) ?? [];
    const remoteBaseStored = await this.remoteBaseStored(relPath, file.base, seen);

    const decision = decidePull({
      tracked,
      pendingConflict,
      unsafe: local.kind === "unsafe",
      local: localSha,
      base,
      seen,
      remote: { sha: file.sha256, base: file.base },
      pushed,
      remoteBaseStored,
    });

    switch (decision.kind) {
      case "skip":
        return this.skip(file, decision.reason, decision.nextBase, local);
      case "create":
      case "overwrite": {
        const list = decision.kind === "create" ? this.result.created : this.result.overwritten;
        if (this.dryRun) {
          list.push(relPath);
          this.use(file);
          return;
        }
        if (local.kind === "unsafe") return; // decidePull 已经排除，这里只为收窄类型
        // 判定用的本地 hash 可能来自按 size + mtime 命中的缓存：覆盖前按实际内容再核对一次，
        // 对不上说明本地改过（mtime 精度较粗时可能看不出来），这次不动它，下次拉取重新判定
        if (local.kind === "file" && localSha !== null && (await this.readLocal(local, localSha)) === null) {
          this.result.skippedUnsafe.push(relPath);
          return;
        }
        const bytes = await this.fetchRemote(file);
        if (bytes === null || !(await this.write(relPath, bytes, local))) return;
        await this.adoptBase(relPath, file.sha256, bytes);
        this.remember(relPath, file.sha256);
        list.push(relPath);
        this.use(file);
        return;
      }
      case "merge":
        if (local.kind !== "file" || localSha === null) return;
        return this.merge(file, local, localSha, decision.base);
      case "conflict": {
        // 两边都改了、没有可用的共同基准，直接登记冲突。dry-run 只列出，不下载
        if (this.dryRun) return this.registerConflict(file, null, null);
        const bytes = await this.fetchRemote(file);
        if (bytes === null) return;
        return this.registerConflict(file, bytes, null);
      }
    }
  }

  private async skip(
    file: RemoteFile,
    reason: "tracked" | "conflict" | "unsafe" | "same" | "local-deleted" | "local-changed" | "stale",
    nextBase: string | null | "keep",
    local: LocalEntry,
  ): Promise<void> {
    const relPath = file.path;
    switch (reason) {
      case "tracked":
        this.result.skippedTracked.push(relPath);
        return;
      case "unsafe":
        this.result.skippedUnsafe.push(relPath);
        return;
      case "same": {
        // 两边内容相同：本机确认过这份内容，基准改成它（内容就是本地文件）
        if (this.dryRun || local.kind !== "file" || !isNewBase(nextBase)) return;
        this.remember(relPath, file.sha256);
        const bytes = await this.readLocal(local, file.sha256);
        if (bytes !== null) await this.adoptBase(relPath, file.sha256, bytes);
        return;
      }
      case "stale": {
        // 对方给的是本机见过的旧版本：没有基准时先把它采纳为基准（需要下载内容）；这一步成功之后，
        // 同一路径同一份内容只在第一次遇到时列出并记下，这样中途失败不会丢掉第一次的报告。
        // 旧版本的内容没有被取用，不计入来源机器
        if (!this.dryRun && isNewBase(nextBase)) {
          const bytes = await this.fetchRemote(file);
          if (bytes === null) return;
          await this.adoptBase(relPath, nextBase, bytes, { keepPushed: true });
        }
        if (this.state.staleReported.get(relPath) !== file.sha256) {
          this.result.stale.push(relPath);
          if (!this.dryRun) this.state.staleReported.set(relPath, file.sha256);
        }
        return;
      }
      default:
        // conflict：保持已有冲突；local-deleted：尊重本地删除；local-changed：本地改过、对方没改
        return;
    }
  }

  /** 两边都改了：用 mergeBase（本机基准，或对方推送时基于的、本机推送过的某个版本）做三方合并 */
  private async merge(
    file: RemoteFile,
    local: Extract<LocalEntry, { kind: "file" }>,
    localSha: string,
    mergeBase: string,
  ): Promise<void> {
    const relPath = file.path;
    const localBytes = await this.readLocal(local, localSha);
    if (localBytes === null) {
      // 判定之后本地文件又被改了：这次不动它，下次拉取重新判定
      this.result.skippedUnsafe.push(relPath);
      return;
    }
    const remoteBytes = await this.fetchRemote(file);
    if (remoteBytes === null) return;
    const baseBytes = await this.state.readBlob(mergeBase);
    if (baseBytes === null) return this.registerConflict(file, remoteBytes, null);
    if (looksBinary(localBytes) || looksBinary(remoteBytes) || looksBinary(baseBytes)) {
      return this.registerConflict(file, remoteBytes, mergeBase);
    }

    const merged = await mergeText(this.ctx, localBytes, baseBytes, remoteBytes);
    if (!merged.clean) return this.registerConflict(file, remoteBytes, mergeBase);

    if (!this.dryRun) {
      if (!(await this.write(relPath, merged.merged, local))) return;
      // 自动合并：基准取对方内容，这样本机推送合并结果后，对方能按快进直接接受
      await this.adoptBase(relPath, file.sha256, remoteBytes);
      this.remember(relPath, file.sha256, sha256Hex(merged.merged));
    }
    this.result.merged.push(relPath);
    this.use(file);
  }
}

function pullReportOf(result: PullResult): PullReportInput | null {
  const counts = {
    created: result.created.length,
    overwritten: result.overwritten.length,
    merged: result.merged.length,
    conflicts: result.conflicts.length,
    stale: result.stale.length,
  };
  const total = counts.created + counts.overwritten + counts.merged + counts.conflicts + counts.stale;
  return total === 0 ? null : { ...counts, fromMachineIds: result.fromMachineIds };
}

/**
 * 把其他机器的文档版本拉到本地（规格 9.3，逐文件规则见 core 的 decidePull）。
 * 非 dry-run 时全程在项目级的同步锁里执行；有新建、覆盖、自动合并、新登记的冲突或新跳过的
 * 旧版本时，结束后调用 sync/pulled 记一条 docs.pulled 事件，这个请求失败只输出一行警告。
 */
export async function pullDocs(ctx: CliContext, repo: RegisteredRepo, client: ApiClient, opts: PullOptions): Promise<PullResult> {
  assertValidScope(repo.config);
  if (opts.pathGlob !== undefined) {
    const problem = validateSyncGlob(opts.pathGlob);
    if (problem !== null) throw new CliError(EXIT.USAGE, `--path 的写法不对：${problem}`);
  }
  const projectId = repo.config.projectId;
  const selfId = await requireSelfMachineId(ctx);
  const remote = await selectRemote(client, projectId, selfId, opts.from);

  const inScope = createSyncScopeMatcher(toSyncScope(repo.config));
  const matchesPath = opts.pathGlob !== undefined ? picomatch(opts.pathGlob, { dot: true }) : () => true;
  const files = remote.files
    .filter((file) => inScope(file.path) && matchesPath(file.path))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const isTracked = await listTrackedPaths(ctx, repo.root);

  let pull: PullRun | null = null;
  const run = async (): Promise<PullResult> => {
    const state = await openSyncState(ctx, projectId, repo.root);
    pull = new PullRun(ctx, repo.root, client, projectId, state, isTracked, remote.nameOf, opts.dryRun);
    let completed = false;
    try {
      for (const file of files) {
        if (opts.deadline !== undefined && ctx.now().getTime() >= opts.deadline) {
          pull.result.timedOut = true;
          break;
        }
        await pull.process(file);
      }
      completed = true;
    } finally {
      // 出错、超时也要保存：已经写入的文件与基准、hash 缓存保持一致
      if (!opts.dryRun) {
        if (completed) await state.gcBlobs();
        await state.save();
      }
    }
    return pull.finish();
  };

  const report = async (result: PullResult): Promise<void> => {
    const body = opts.dryRun ? null : pullReportOf(result);
    if (body === null) return;
    try {
      await client.post(`/api/v1/projects/${projectId}/sync/pulled`, body, okResponse);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      ctx.stderr.write(`警告：记录拉取事件失败（${reason}），拉取结果不受影响\n`);
    }
  };

  let result: PullResult;
  try {
    result = opts.dryRun ? await run() : await withSyncLock(ctx, projectId, run);
  } catch (err) {
    // 中途出错：已完成的部分照常记事件，并挂在错误上交给命令层输出，然后原样抛出
    const started = pull as PullRun | null;
    if (started !== null) {
      const partial = started.finish();
      await report(partial);
      if (typeof err === "object" && err !== null) partialResults.set(err, partial);
    }
    throw err;
  }
  await report(result);
  return result;
}

const partialResults = new WeakMap<object, PullResult>();

/** pullDocs 中途出错时，取出出错之前已经完成的部分结果；不是拉取途中的错误时返回 null */
export function partialPullResultOf(err: unknown): PullResult | null {
  if (typeof err !== "object" || err === null) return null;
  return partialResults.get(err) ?? null;
}

/**
 * 渲染 kh pull 的结果：按类别分组列出路径，跳过的只给数量，有冲突时最后一行提示下一步。
 * interrupted 为 true 时表示拉取中途出错，这里列出的是出错之前已经完成的部分。
 */
export function renderPullResult(result: PullResult, dryRun: boolean, interrupted = false): string {
  const prefix = dryRun ? "将要" : "";
  const groups: [string, string[]][] = [
    [dryRun ? "将要新建" : "新建", result.created],
    [dryRun ? "将要覆盖" : "覆盖", result.overwritten],
    [dryRun ? "将要自动合并" : "自动合并", result.merged],
    [dryRun ? "将要登记冲突" : "冲突", result.conflicts],
    [`${prefix}跳过旧版本`, result.stale],
  ];

  const lines: string[] = [];
  if (interrupted) lines.push("拉取中途出错，出错之前已完成的部分：");
  if (dryRun) lines.push("试运行，不写入任何文件：");
  for (const [label, paths] of groups) {
    if (paths.length === 0) continue;
    lines.push(`${label}（${paths.length}）：`);
    for (const p of paths) lines.push(`  ${p}`);
  }
  if (lines.length === (dryRun ? 1 : 0) + (interrupted ? 1 : 0)) {
    if (interrupted) lines.push("（出错之前没有完成任何文件）");
    else lines.push(dryRun ? "没有需要拉取的变化" : "已是最新，没有需要拉取的变化");
  }
  if (result.skippedTracked.length > 0) lines.push(`被 git 跟踪、已跳过：${result.skippedTracked.length} 个`);
  if (result.skippedUnsafe.length > 0) lines.push(`路径不安全、已跳过：${result.skippedUnsafe.length} 个`);
  if (result.skippedChanged.length > 0) {
    lines.push(`对方在拉取过程中更新了这些文件，已跳过，稍后重新执行 kh pull：`);
    for (const p of result.skippedChanged) lines.push(`  ${p}`);
  }
  if (result.timedOut) lines.push("拉取超时，已停止；已写入的文件保留，稍后执行 kh pull 继续");
  if (!dryRun && result.conflicts.length > 0) {
    lines.push(`下一步：执行 kh conflicts show ${result.conflicts[0]} 查看冲突`);
  }
  return `${lines.join("\n")}\n`;
}
