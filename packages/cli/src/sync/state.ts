import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { formatZodError } from "@kanban-hub/core/errors";
import { idSchema } from "@kanban-hub/core/ids";
import { timestampSchema } from "@kanban-hub/core/schema";
import { resolveKhHome } from "../config/home";
import type { CliContext } from "../context";
import { CliError, EXIT } from "../errors";
import { isNoEntError, writeFileAtomic } from "../fs-utils";

const SHA256_RE = /^[0-9a-f]{64}$/;
const shaSchema = z.string().regex(SHA256_RE, "必须是 64 位十六进制的 SHA-256");

export interface SyncFileRef {
  path: string;
  size: number;
  mtimeMs: number;
  absPath: string;
}

export interface ConflictRecord {
  remoteSha: string;
  remoteMachineId: string;
  /** 登记时对方机器的名称，供离线查看冲突时显示；缺失时显示机器 ID */
  remoteMachineName?: string;
  /** 本机当时的基准内容；两边都改了同一份基准之外的内容时为 null（没有可用的基准） */
  baseSha: string | null;
  detectedAt: string;
}

export interface LastPush {
  at: string;
  /** 推送清单（文件列表含基准、git 状态、跳过的文件、同步范围）的 sha256 */
  digest: string;
}

export interface SyncState {
  /** 命中 size+mtime 都不变的缓存就直接返回，不重新读文件；否则流式读取计算并写入缓存 */
  hashOf(file: SyncFileRef): Promise<string>;
  /** kh 自己刚写入一个文件后，直接记下它的 size、mtime 和 hash，免得下次同步重新读取计算 */
  recordHash(filePath: string, size: number, mtimeMs: number, sha: string): void;
  /** 路径 → 基准内容的 sha256：拉取写入、两边内容相同、自动合并、解决冲突时更新 */
  base: Map<string, string>;
  /** 路径 → 本机曾经推送过 / 写入过 / 确认过的内容 hash，最多保留最近若干个（由调用方决定） */
  seen: Map<string, string[]>;
  /** 路径 → 尚未解决的冲突 */
  conflicts: Map<string, ConflictRecord>;
  /** 路径 → 已经报告过的“对方给的是旧版本”的那个 hash，避免重复提醒 */
  staleReported: Map<string, string>;
  /** 本机上一次成功推送的时间与清单摘要；hook 的后台同步据此跳过没有变化的推送。从没推送过时为 null */
  lastPush: LastPush | null;
  putBlob(sha: string, bytes: Uint8Array): Promise<void>;
  readBlob(sha: string): Promise<Uint8Array | null>;
  /** 原子写回 state.json */
  save(): Promise<void>;
  /** 删除不再被 base 或 conflicts 引用的 blob */
  gcBlobs(): Promise<void>;
}

const hashCacheEntrySchema = z.object({
  size: z.number().int().min(0),
  mtimeMs: z.number(),
  sha: shaSchema,
});

const conflictRecordSchema = z.object({
  remoteSha: shaSchema,
  remoteMachineId: idSchema,
  remoteMachineName: z.string().optional(),
  baseSha: shaSchema.nullable(),
  detectedAt: timestampSchema,
});

const stateFileSchema = z.object({
  /** 上次打开时的仓库根：换了仓库根之后，本地路径对应的含义不再可信，据此丢弃 hash 缓存 */
  root: z.string(),
  hashCache: z.record(z.string(), hashCacheEntrySchema).default({}),
  base: z.record(z.string(), shaSchema).default({}),
  seen: z.record(z.string(), z.array(shaSchema)).default({}),
  conflicts: z.record(z.string(), conflictRecordSchema).default({}),
  staleReported: z.record(z.string(), shaSchema).default({}),
  /** 旧版本写的状态文件没有这个字段，照常读取 */
  lastPush: z.object({ at: timestampSchema, digest: shaSchema }).optional(),
});

function cacheDir(home: string, projectId: string): string {
  return path.join(home, "cache", projectId);
}

function statePath(dir: string): string {
  return path.join(dir, "state.json");
}

function blobsDir(dir: string): string {
  return path.join(dir, "blobs");
}

function corruptedError(dir: string, reason: string): CliError {
  return new CliError(
    EXIT.UNEXPECTED,
    `本机同步状态文件损坏，无法解析：${statePath(dir)}（${reason}）`,
    `删除 ${dir} 后重试；重建会丢失基准，下次同步或拉取可能会多出一些冲突需要处理`,
  );
}

/** 流式计算文件内容的 sha256，不把整个文件读进内存 */
async function hashFile(absPath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(absPath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

/** 打开某个项目在本机的同步状态：读取缓存文件、按 schema 校验，仓库根变化时丢弃 hash 缓存但保留基准和 seen */
export async function openSyncState(ctx: CliContext, projectId: string, root: string): Promise<SyncState> {
  const home = resolveKhHome(ctx);
  const dir = cacheDir(home, projectId);
  const file = statePath(dir);
  const blobs = blobsDir(dir);

  let raw: string | null;
  try {
    raw = await fsp.readFile(file, "utf8");
  } catch (err) {
    if (!isNoEntError(err)) throw err;
    raw = null;
  }

  let hashCache = new Map<string, z.infer<typeof hashCacheEntrySchema>>();
  let base = new Map<string, string>();
  let seen = new Map<string, string[]>();
  let conflicts = new Map<string, ConflictRecord>();
  let staleReported = new Map<string, string>();
  let lastPush: LastPush | null = null;

  if (raw !== null) {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (err) {
      throw corruptedError(dir, err instanceof Error ? err.message : String(err));
    }
    const result = stateFileSchema.safeParse(parsedJson);
    if (!result.success) {
      throw corruptedError(dir, formatZodError(result.error).join("；"));
    }
    const data = result.data;
    base = new Map(Object.entries(data.base));
    seen = new Map(Object.entries(data.seen));
    conflicts = new Map(Object.entries(data.conflicts));
    staleReported = new Map(Object.entries(data.staleReported));
    lastPush = data.lastPush ?? null;
    if (data.root === root) {
      hashCache = new Map(Object.entries(data.hashCache));
    }
  }

  const state: SyncState = {
    base,
    seen,
    conflicts,
    staleReported,
    lastPush,

    async hashOf(target) {
      const cached = hashCache.get(target.path);
      if (cached && cached.size === target.size && cached.mtimeMs === target.mtimeMs) {
        return cached.sha;
      }
      const sha = await hashFile(target.absPath);
      hashCache.set(target.path, { size: target.size, mtimeMs: target.mtimeMs, sha });
      return sha;
    },

    recordHash(filePath, size, mtimeMs, sha) {
      hashCache.set(filePath, { size, mtimeMs, sha });
    },

    async putBlob(sha, bytes) {
      await writeFileAtomic(path.join(blobs, sha), bytes, { mkdir: true });
    },

    async readBlob(sha) {
      try {
        return await fsp.readFile(path.join(blobs, sha));
      } catch (err) {
        if (isNoEntError(err)) return null;
        throw err;
      }
    },

    async save() {
      const payload = stateFileSchema.parse({
        root,
        hashCache: Object.fromEntries(hashCache),
        base: Object.fromEntries(base),
        seen: Object.fromEntries(seen),
        conflicts: Object.fromEntries(conflicts),
        staleReported: Object.fromEntries(staleReported),
        ...(state.lastPush !== null ? { lastPush: state.lastPush } : {}),
      });
      await writeFileAtomic(file, JSON.stringify(payload, null, 2), { mkdir: true });
    },

    async gcBlobs() {
      const referenced = new Set<string>(base.values());
      for (const conflict of conflicts.values()) {
        referenced.add(conflict.remoteSha);
        if (conflict.baseSha !== null) referenced.add(conflict.baseSha);
      }

      let entries: string[];
      try {
        entries = await fsp.readdir(blobs);
      } catch (err) {
        if (isNoEntError(err)) return;
        throw err;
      }
      await Promise.all(
        entries.filter((name) => !referenced.has(name)).map((name) => fsp.rm(path.join(blobs, name), { force: true })),
      );
    },
  };
  return state;
}
