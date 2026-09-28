/**
 * kh sync 的核心逻辑：把本机同步范围内的文档推送到服务端。kh sync 本身、register 的首次同步、
 * 以及 M6 的 Stop hook 都调用这个函数，命令行外壳只负责取仓库配置和登录态。
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { z } from "zod";
import {
  syncCommitResponse,
  syncManifestResponse,
  syncMissingDetails,
  type SyncCommitInput,
  type SyncCommitResponse,
  type SyncManifestInput,
} from "@kanban-hub/core/api";
import { rememberSeen } from "@kanban-hub/core/pull";
import { validateSyncGlob, type IncomingFile } from "@kanban-hub/core/sync";
import type { RegisteredRepo } from "../repo/root";
import { toSyncScope } from "../repo/config";
import type { CliContext } from "../context";
import { CliError, EXIT } from "../errors";
import type { ApiClient } from "../http/client";
import { formatByteSize } from "../repo/config";
import { collectGitState } from "./git-state";
import { withSyncLock } from "./lock";
import { scanSyncFiles, type ScanResult } from "./scan";
import { openSyncState } from "./state";

export interface PushResult {
  added: number;
  modified: number;
  removed: number;
  unchanged: number;
  skipped: { path: string; size: number }[];
  ignoredLinks: string[];
}

/** PUT /sync/blobs/:sha256 的响应形状；服务端只回 { ok: true }，没有单独定义在 core 的 api schema 里 */
const putBlobResponse = z.object({ ok: z.literal(true) });

/**
 * 标记“这次失败不该重来”：503（服务端还在处理上一次同步）和上传内容时发现文件被改动，
 * 都属于重新走一遍同样会失败（或者不安全）的情况，直接把内部的 CliError 抛给调用方。
 */
class NoRetryError extends Error {
  constructor(readonly cliError: CliError) {
    super(cliError.message);
    this.name = "NoRetryError";
  }
}

/** 校验仓库配置里 include / exclude 每一条 glob 的写法，不合法时指出具体是哪一条 */
export function assertValidScope(config: RegisteredRepo["config"]): void {
  for (const glob of config.sync.include) {
    const problem = validateSyncGlob(glob);
    if (problem !== null) throw new CliError(EXIT.USAGE, `include 里的同步范围写法不对：${problem}`);
  }
  for (const glob of config.sync.exclude) {
    const problem = validateSyncGlob(glob);
    if (problem !== null) throw new CliError(EXIT.USAGE, `exclude 里的同步范围写法不对：${problem}`);
  }
}

/** commit 失败的 details 是不是“缺少内容”（400 missingBlobs）；不是就返回 null，由调用方按其他原因处理 */
function extractMissingBlobs(err: unknown): string[] | null {
  if (!(err instanceof CliError) || err.exitCode !== EXIT.DATA) return null;
  const parsed = syncMissingDetails.safeParse(err.details);
  if (!parsed.success || parsed.data.missingBlobs.length === 0) return null;
  return parsed.data.missingBlobs;
}

interface AttemptResult {
  counts: Pick<SyncCommitResponse, "added" | "modified" | "removed" | "unchanged">;
  scan: ScanResult;
}

/** 一次完整的尝试：扫描 → 计算 hash → 采集 git 状态 → manifest → 补传缺少的内容 → commit */
async function runAttempt(
  ctx: CliContext,
  repo: RegisteredRepo,
  client: ApiClient,
  projectId: string,
): Promise<AttemptResult> {
  const scope = toSyncScope(repo.config);
  const scan = await scanSyncFiles(repo.root, scope);
  const state = await openSyncState(ctx, projectId, repo.root);

  const shaByPath = new Map<string, string>();
  const absByFirstSha = new Map<string, string>();
  const files: IncomingFile[] = [];
  for (const file of scan.files) {
    const sha = await state.hashOf({ path: file.path, size: file.size, mtimeMs: file.mtimeMs, absPath: file.absPath });
    shaByPath.set(file.path, sha);
    if (!absByFirstSha.has(sha)) absByFirstSha.set(sha, file.absPath);
    files.push({
      path: file.path,
      sha256: sha,
      size: file.size,
      mtime: Math.floor(file.mtimeMs),
      base: state.base.get(file.path) ?? null,
    });
  }

  const git = await collectGitState(ctx, repo.root);

  const manifestBody: SyncManifestInput = { files, git, skipped: scan.skipped, scope };
  const manifest = await client.post(`/api/v1/projects/${projectId}/sync/manifest`, manifestBody, syncManifestResponse);

  async function uploadOne(sha: string): Promise<void> {
    const absPath = absByFirstSha.get(sha);
    if (absPath === undefined) {
      throw new CliError(EXIT.UNEXPECTED, `内部错误：服务端要求补传的内容在本次扫描里找不到对应文件：${sha}`);
    }
    const bytes = await fs.readFile(absPath);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== sha) {
      throw new NoRetryError(
        new CliError(EXIT.UNEXPECTED, "文件在同步过程中被修改，内容对不上，请重新执行 kh sync"),
      );
    }
    await client.putBytes(`/api/v1/projects/${projectId}/sync/blobs/${sha}`, bytes, putBlobResponse);
  }

  for (const sha of manifest.missing) await uploadOne(sha);

  const commitInput: SyncCommitInput = { syncId: manifest.syncId };
  let commitResp: SyncCommitResponse;
  try {
    commitResp = await client.post(`/api/v1/projects/${projectId}/sync/commit`, commitInput, syncCommitResponse);
  } catch (err) {
    const retryMissing = extractMissingBlobs(err);
    if (retryMissing !== null) {
      // commit 报缺少内容时，往同一个 syncId 补传后再 commit 一次；
      // 这次还失败（不管是同样原因还是别的原因）就交给外层从头重新来一次
      for (const sha of retryMissing) await uploadOne(sha);
      commitResp = await client.post(`/api/v1/projects/${projectId}/sync/commit`, commitInput, syncCommitResponse);
    } else if (err instanceof CliError && err.exitCode === EXIT.UNREACHABLE) {
      // 503：服务端上一次同步还没应用完成，不重来，直接报错
      throw new NoRetryError(new CliError(EXIT.UNEXPECTED, "服务端还在处理上一次同步，请稍后重试"));
    } else {
      // 其余原因（例如暂存已过期的 404）交给外层从头重新来一次
      throw err;
    }
  }

  // 推送成功：把本次涉及的内容记进 seen（不改基准，见与规格的出入第 1 条），再清理不再引用的
  // 本机缓存内容，最后落盘
  for (const [filePath, sha] of shaByPath) {
    state.seen.set(filePath, rememberSeen(state.seen.get(filePath) ?? [], sha));
  }
  await state.gcBlobs();
  await state.save();

  return {
    counts: {
      added: commitResp.added,
      modified: commitResp.modified,
      removed: commitResp.removed,
      unchanged: commitResp.unchanged,
    },
    scan,
  };
}

function renderSummary(result: PushResult): string {
  const total = result.added + result.modified + result.removed + result.unchanged;
  const lines: string[] = [];
  if (result.added + result.modified + result.removed === 0) {
    lines.push(`已同步 ${total} 个文件：没有变化`);
  } else {
    lines.push(`已同步 ${total} 个文件：新增 ${result.added}、修改 ${result.modified}、删除 ${result.removed}`);
  }
  if (result.skipped.length > 0) {
    lines.push("超过大小限制，已跳过：");
    for (const item of result.skipped) lines.push(`  ${item.path}（${formatByteSize(item.size)}）`);
  }
  if (result.ignoredLinks.length > 0) {
    lines.push("指向仓库外或已失效，已跳过的软链接：");
    for (const link of result.ignoredLinks) lines.push(`  ${link}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * 把本机同步范围内的文档推送到服务端：kh sync、register 的首次同步、M6 的 Stop hook 共用。
 * 全程在项目级的同步锁里执行；失败一次会自动从头重新来一次，第二次还失败就把错误
 * 抛给调用方。成功后按 quiet 决定要不要把结果摘要写到 ctx.stdout；同步本身不算一次上报，不会更新最近上报时间。
 */
export async function pushDocs(
  ctx: CliContext,
  repo: RegisteredRepo,
  client: ApiClient,
  opts: { quiet: boolean },
): Promise<PushResult> {
  assertValidScope(repo.config);
  const projectId = repo.config.projectId;

  const result = await withSyncLock(ctx, projectId, async (): Promise<PushResult> => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const { counts, scan } = await runAttempt(ctx, repo, client, projectId);
        return { ...counts, skipped: scan.skipped, ignoredLinks: scan.ignoredLinks };
      } catch (err) {
        if (err instanceof NoRetryError) throw err.cliError;
        lastErr = err;
        if (attempt === 2) throw err;
      }
    }
    throw lastErr;
  });

  if (!opts.quiet) ctx.stdout.write(renderSummary(result));
  return result;
}
