import { z } from "zod";
import { idSchema } from "./ids";
import {
  SYNC_ALWAYS_EXCLUDE,
  SYNC_DEFAULT_MAX_FILE_SIZE,
  SYNC_MAX_FILE_SIZE_LIMIT,
  sha256HexSchema,
  snapshotPathSchema,
  timestampSchema,
  type Event,
} from "./schema";

// 这三个常量的定义搬到了 schema.ts（syncScopeSchema 需要用到 SYNC_MAX_FILE_SIZE_LIMIT），
// 这里转出，保持原来的导入路径不变。
export { SYNC_ALWAYS_EXCLUDE, SYNC_DEFAULT_MAX_FILE_SIZE, SYNC_MAX_FILE_SIZE_LIMIT, sha256HexSchema, snapshotPathSchema };

/** 一次同步清单最多容纳的文件数 */
export const SYNC_MAX_MANIFEST_FILES = 20000;

/** 同步暂存的有效期：超过这个时长仍未提交的暂存会被清理 */
export const SYNC_STAGING_TTL_MS = 24 * 60 * 60 * 1000;

// ---------- 同步范围 glob ----------

/**
 * 校验同步范围的 glob 写法：不能为空、必须是 POSIX 形式、不能以 / 开头、不能含 .. 段。
 * glob 本身的匹配语义（picomatch）由使用方实现，这里只管写法。返回错误信息，写法合法时返回 null。
 */
export function validateSyncGlob(glob: string): string | null {
  if (glob === "") return "同步范围不能是空字符串";
  if (glob.includes("\\")) return `同步范围必须是 POSIX 形式（不能包含 \\）：${glob}`;
  if (glob.startsWith("/")) return `同步范围不能以 / 开头：${glob}`;
  if (glob.split("/").includes("..")) return `同步范围不能包含 ..：${glob}`;
  return null;
}

export const syncGlobSchema = z.string().superRefine((glob, ctx) => {
  const problem = validateSyncGlob(glob);
  if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
});

// ---------- 清单路径 ----------

/**
 * 检查一批路径是否互相冲突：完全重复、只差大小写（服务端的数据目录可能在不区分大小写的
 * 文件系统上），或者一个路径是另一个路径的上级目录。返回第一条问题的中文描述，没问题时返回 null。
 */
export function findManifestPathProblem(paths: readonly string[]): string | null {
  const seenLower = new Map<string, string>();
  for (const p of paths) {
    const lower = p.toLowerCase();
    const other = seenLower.get(lower);
    if (other !== undefined) {
      return other === p ? `路径重复：${p}` : `路径只有大小写不同：${other} 与 ${p}`;
    }
    seenLower.set(lower, p);
  }

  const pathSet = new Set(paths);
  for (const p of paths) {
    const segments = p.split("/");
    for (let i = 1; i < segments.length; i++) {
      const prefix = segments.slice(0, i).join("/");
      if (pathSet.has(prefix)) return `路径冲突：${prefix} 既是文件又是目录（因为清单里还有 ${p}）`;
    }
  }
  return null;
}

// ---------- 清单文件 ----------

const fileCoreFields = {
  path: snapshotPathSchema,
  sha256: sha256HexSchema,
  size: z.number().int().min(0),
  mtime: z.number().int().min(0),
  base: sha256HexSchema.nullable(),
};

/** 一次同步提交里，kh 上报的单个文件 */
export const incomingFileSchema = z.object(fileCoreFields);
export type IncomingFile = z.infer<typeof incomingFileSchema>;

/** 服务端为每台机器维护的清单里的单个文件条目 */
export const manifestFileSchema = z.object({ ...fileCoreFields, changedAt: timestampSchema });
export type ManifestFile = z.infer<typeof manifestFileSchema>;

/** 选出对方版本后，多带一个来源机器 ID */
export type RemoteFile = ManifestFile & { machineId: string };

/** manifests/<机器ID>.json 的内容 */
export const snapshotManifestSchema = z
  .object({
    machineId: idSchema,
    updatedAt: timestampSchema,
    files: z.array(manifestFileSchema).max(SYNC_MAX_MANIFEST_FILES, `一份清单最多 ${SYNC_MAX_MANIFEST_FILES} 个文件`),
  })
  .superRefine((manifest, ctx) => {
    const problem = findManifestPathProblem(manifest.files.map((f) => f.path));
    if (problem !== null) ctx.addIssue({ code: "custom", path: ["files"], message: problem });
  });
export type SnapshotManifest = z.infer<typeof snapshotManifestSchema>;

/**
 * 把一次同步提交的内容套用到已有清单上：新增、修改、删除的路径分别列出，
 * changedAt 按约定计算——同一路径的 hash 与上一份清单不同（或者上一份清单里没有这个路径）
 * 时记为本次的 committedAt，否则沿用原值；据此重放同一份输入，结果不变。
 * 返回的 next.files 按路径排序，保证写出的清单稳定。
 */
export function applyManifestDiff(
  prev: SnapshotManifest | null,
  incoming: readonly IncomingFile[],
  machineId: string,
  committedAt: string,
): { next: SnapshotManifest; added: string[]; modified: string[]; removed: string[]; unchanged: number } {
  const prevByPath = new Map((prev?.files ?? []).map((f) => [f.path, f] as const));
  const incomingPaths = new Set(incoming.map((f) => f.path));

  const added: string[] = [];
  const modified: string[] = [];
  let unchanged = 0;

  const files: ManifestFile[] = incoming.map((f) => {
    const prevFile = prevByPath.get(f.path);
    let changedAt: string;
    if (prevFile === undefined) {
      added.push(f.path);
      changedAt = committedAt;
    } else if (prevFile.sha256 !== f.sha256) {
      modified.push(f.path);
      changedAt = committedAt;
    } else {
      unchanged += 1;
      changedAt = prevFile.changedAt;
    }
    return { path: f.path, sha256: f.sha256, size: f.size, mtime: f.mtime, base: f.base, changedAt };
  });

  const removed = [...prevByPath.keys()].filter((path) => !incomingPaths.has(path));

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return { next: { machineId, updatedAt: committedAt, files }, added, modified, removed, unchanged };
}

/**
 * 按 changedAt 挑选每个路径“对方”的最新版本：changedAt 相同时取所属清单 updatedAt 较新的
 * 机器，再相同时按 machineId 字典序取较小的一个，保证结果确定。exclude 为 null 时所有机器
 * 都参与，否则忽略该机器的清单。
 */
export function pickLatestRemote(
  manifests: readonly { machineId: string; updatedAt: string; files: readonly ManifestFile[] }[],
  exclude: string | null,
): RemoteFile[] {
  const best = new Map<string, { file: RemoteFile; manifestUpdatedAt: string }>();

  for (const manifest of manifests) {
    if (exclude !== null && manifest.machineId === exclude) continue;
    for (const file of manifest.files) {
      const candidate: RemoteFile = { ...file, machineId: manifest.machineId };
      const current = best.get(file.path);
      if (current === undefined || isNewerRemote(candidate, manifest.updatedAt, current.file, current.manifestUpdatedAt)) {
        best.set(file.path, { file: candidate, manifestUpdatedAt: manifest.updatedAt });
      }
    }
  }

  return [...best.values()].map((v) => v.file).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function isNewerRemote(candidate: RemoteFile, candidateUpdatedAt: string, current: RemoteFile, currentUpdatedAt: string): boolean {
  if (candidate.changedAt !== current.changedAt) return candidate.changedAt > current.changedAt;
  if (candidateUpdatedAt !== currentUpdatedAt) return candidateUpdatedAt > currentUpdatedAt;
  return candidate.machineId < current.machineId;
}

// ---------- docs.synced / docs.pulled 事件 ----------

interface FieldChangeShape {
  from?: unknown;
  to?: unknown;
}

export interface DocsSyncedCounts {
  added: number;
  modified: number;
  removed: number;
}

/** docs.synced 事件的 change：只在有新增、修改或删除时才应该记这条事件 */
export function docsSyncedChange(counts: DocsSyncedCounts): Record<string, FieldChangeShape> {
  return {
    added: { to: counts.added },
    modified: { to: counts.modified },
    removed: { to: counts.removed },
  };
}

export interface DocsPulledCounts {
  created: number;
  overwritten: number;
  merged: number;
  conflicts: number;
  stale: number;
}

/** docs.pulled 事件的 change：额外带上本次实际取用了哪些机器的版本 */
export function docsPulledChange(counts: DocsPulledCounts, fromMachineIds: readonly string[]): Record<string, FieldChangeShape> {
  return {
    created: { to: counts.created },
    overwritten: { to: counts.overwritten },
    merged: { to: counts.merged },
    conflicts: { to: counts.conflicts },
    stale: { to: counts.stale },
    from: { to: [...fromMachineIds] },
  };
}

export type DocsCounts =
  | ({ type: "docs.synced" } & DocsSyncedCounts)
  | ({ type: "docs.pulled"; fromMachineIds: string[] } & DocsPulledCounts);

function readCount(change: Record<string, FieldChangeShape> | null, key: string): number | null {
  const value = change?.[key]?.to;
  return typeof value === "number" ? value : null;
}

/**
 * 从事件里读出 docs.synced / docs.pulled 的计数，与 docsSyncedChange / docsPulledChange
 * 互为逆运算。事件类型不是这两种，或者 change 的格式不对，一律返回 null，不抛错。
 */
export function readDocsCounts(event: Event): DocsCounts | null {
  if (event.type === "docs.synced") {
    const added = readCount(event.change, "added");
    const modified = readCount(event.change, "modified");
    const removed = readCount(event.change, "removed");
    if (added === null || modified === null || removed === null) return null;
    return { type: "docs.synced", added, modified, removed };
  }

  if (event.type === "docs.pulled") {
    const created = readCount(event.change, "created");
    const overwritten = readCount(event.change, "overwritten");
    const merged = readCount(event.change, "merged");
    const conflicts = readCount(event.change, "conflicts");
    const stale = readCount(event.change, "stale");
    const from = event.change?.["from"]?.to;
    if (created === null || overwritten === null || merged === null || conflicts === null || stale === null) return null;
    if (!Array.isArray(from) || !from.every((id) => typeof id === "string")) return null;
    return { type: "docs.pulled", created, overwritten, merged, conflicts, stale, fromMachineIds: from };
  }

  return null;
}
