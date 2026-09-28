import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { syncManifestInput } from "@kanban-hub/core/api";
import { KhError, formatZodError, parseInput } from "@kanban-hub/core/errors";
import { idSchema } from "@kanban-hub/core/ids";
import { actorSchema, timestampSchema } from "@kanban-hub/core/schema";
import {
  type ManifestFile,
  type SnapshotManifest,
  sha256HexSchema,
  snapshotManifestSchema,
  snapshotPathSchema,
} from "@kanban-hub/core/sync";
import { DataFileError, writeFileAtomic } from "./fsio";

/** 同步暂存目录（相对数据目录），不进 git */
export const STAGING_DIR = ".staging";
/** 原子写入的临时文件目录（相对数据目录），不进 git，启动时清空 */
export const TMP_DIR = ".tmp";

/**
 * 需要整体核对快照目录的“项目 ID.机器 ID”标记，放在 .staging/ 下的这个子目录里。
 * 一份暂存改到一半后没能按原样应用完（回到 open、超期丢弃、中途失败），快照目录就可能与清单
 * 不一致；这台机器下一次应用时不只按清单差异改，而是把整个快照目录核对成目标清单的样子。
 */
const RECONCILE_DIR = "reconcile";

/** 暂存里的内容与 hash 不符：删掉这份内容，让 kh 补传 */
export class BlobMismatchError extends Error {
  constructor(readonly sha: string) {
    super(`暂存里的内容与 hash 不符：${sha}`);
    this.name = "BlobMismatchError";
  }
}

/** 暂存的 ID：32 位小写十六进制，拼进目录名之前必须先过这个校验 */
export const syncIdSchema = z.string().regex(/^[0-9a-f]{32}$/, "同步会话 ID 格式不对");

/**
 * 暂存的状态：open 可以接收内容；applying 表示内容已经核对齐全、开始改快照，
 * 崩溃后启动时重新应用一遍；applied 表示快照、清单、位置、事件都已完成，只剩删除暂存目录。
 */
export const STAGING_STATES = ["open", "applying", "applied"] as const;

const countSchema = z.number().int().min(0);

export const stagingMetaSchema = z
  .object({
    syncId: syncIdSchema,
    projectId: idSchema,
    machineId: idSchema,
    createdAt: timestampSchema,
    expiresAt: timestampSchema,
    state: z.enum(STAGING_STATES),
    /** 创建时服务端还没有的内容，putSyncBlob 只接收这里列出的 hash */
    missing: z.array(sha256HexSchema),
    input: syncManifestInput,
    /** 进入 applying 时记下，重放时原样使用，保证结果与第一次应用相同 */
    applying: z
      .object({
        committedAt: timestampSchema,
        actor: actorSchema,
        eventId: idSchema,
        counts: z.object({ added: countSchema, modified: countSchema, removed: countSchema, unchanged: countSchema }),
      })
      .nullable(),
  })
  .strict()
  .superRefine((meta, ctx) => {
    if (meta.state !== "open" && meta.applying === null) {
      ctx.addIssue({ code: "custom", path: ["applying"], message: "应用中或已应用的暂存必须带上应用信息" });
    }
  });
export type StagingMeta = z.infer<typeof stagingMetaSchema>;

export function newSyncId(): string {
  return randomBytes(16).toString("hex");
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function manifestRelPath(projectId: string, machineId: string): string {
  return `projects/${projectId}/manifests/${machineId}.json`;
}

export function snapshotRelDir(projectId: string, machineId: string): string {
  return `projects/${projectId}/snapshots/${machineId}`;
}

/**
 * 快照文件的绝对路径：相对路径先过 snapshotPathSchema，拼出的结果还必须位于 root 之内，
 * 否则以 invalid 拒绝。清单进来时已经校验过，这里是写盘前的最后一道防线。
 */
export function resolveSnapshotPath(root: string, rel: string): string {
  if (!snapshotPathSchema.safeParse(rel).success) throw new KhError("invalid", `快照路径不合法：${rel}`);
  const target = path.resolve(root, ...rel.split("/"));
  if (!target.startsWith(path.resolve(root) + path.sep)) throw new KhError("invalid", `快照路径越出了快照目录：${rel}`);
  return target;
}

/**
 * 快照清单（内存缓存 + manifests/*.json）、同步暂存（.staging/）和快照文件本身的读写。
 * 不管写入队列、git 提交和项目数据，这些由 Store 编排；这里的写操作都是幂等的，
 * 可以在崩溃后原样重做。
 */
export class SnapshotRepo {
  /** 项目 ID → 机器 ID → 清单 */
  private readonly manifests = new Map<string, Map<string, SnapshotManifest>>();
  private readonly stagings = new Map<string, StagingMeta>();
  /**
   * 项目 ID → 来源已损坏的内容：清单里有这个 hash，但对应的快照文件读出来对不上。
   * 计算“已有内容”时排除它们，让 kh 重新上传；这份内容再次成功写入快照后移出。只在内存里，
   * 重启后清空——届时最坏是再走一次“commit 报缺失、补传”。
   */
  private readonly corrupt = new Map<string, Set<string>>();
  /** 需要整体核对快照目录的“项目 ID.机器 ID”，与 .staging/reconcile/ 下的标记文件一致 */
  private readonly reconcile = new Set<string>();

  constructor(
    private readonly dataDir: string,
    private readonly tmpDir: string,
    private readonly log: (message: string) => void,
  ) {}

  // ---------- 清单 ----------

  /** 读入项目的全部清单；任何一份解析失败都抛 DataFileError，拒绝启动 */
  async loadManifests(projectId: string): Promise<void> {
    const dir = this.abs(`projects/${projectId}/manifests`);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue;
      const machineId = name.slice(0, -".json".length);
      if (!idSchema.safeParse(machineId).success) continue;
      const file = path.join(dir, name);
      let raw: unknown;
      try {
        raw = JSON.parse(await fs.readFile(file, "utf8"));
      } catch {
        throw new DataFileError(file, null, "不是合法的 JSON");
      }
      const result = snapshotManifestSchema.safeParse(raw);
      if (!result.success) throw new DataFileError(file, null, formatZodError(result.error)[0]!);
      if (result.data.machineId !== machineId) {
        throw new DataFileError(file, null, `machineId（${result.data.machineId}）与文件名不一致`);
      }
      this.cacheManifest(projectId, result.data);
    }
  }

  getManifest(projectId: string, machineId: string): SnapshotManifest | null {
    return this.manifests.get(projectId)?.get(machineId) ?? null;
  }

  listManifests(projectId: string): SnapshotManifest[] {
    const byMachine = this.manifests.get(projectId);
    if (!byMachine) return [];
    return [...byMachine.values()].sort((a, b) => (a.machineId < b.machineId ? -1 : a.machineId > b.machineId ? 1 : 0));
  }

  /** 本项目任意机器当前清单里出现过、而且来源没有被发现损坏的内容 */
  knownHashes(projectId: string): Set<string> {
    const known = new Set<string>();
    for (const manifest of this.listManifests(projectId)) for (const f of manifest.files) known.add(f.sha256);
    for (const sha of this.corrupt.get(projectId) ?? []) known.delete(sha);
    return known;
  }

  markCorrupt(projectId: string, shas: Iterable<string>): void {
    let set = this.corrupt.get(projectId);
    if (!set) {
      set = new Set();
      this.corrupt.set(projectId, set);
    }
    for (const sha of shas) set.add(sha);
  }

  clearCorrupt(projectId: string, shas: Iterable<string>): void {
    const set = this.corrupt.get(projectId);
    if (!set) return;
    for (const sha of shas) set.delete(sha);
  }

  /** 校验后写 manifests/<机器ID>.json，写成功才更新内存 */
  async writeManifest(projectId: string, manifest: SnapshotManifest): Promise<void> {
    const valid = parseInput(snapshotManifestSchema, manifest);
    await writeFileAtomic(this.abs(manifestRelPath(projectId, valid.machineId)), `${JSON.stringify(valid, null, 2)}\n`, {
      tmpDir: this.tmpDir,
    });
    this.cacheManifest(projectId, valid);
  }

  private cacheManifest(projectId: string, manifest: SnapshotManifest): void {
    let byMachine = this.manifests.get(projectId);
    if (!byMachine) {
      byMachine = new Map();
      this.manifests.set(projectId, byMachine);
    }
    byMachine.set(manifest.machineId, manifest);
  }

  // ---------- 暂存 ----------

  /** 启动时读入全部暂存；meta.json 缺失或不合法的目录直接删除（暂存不是数据） */
  async loadStagings(): Promise<StagingMeta[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.abs(STAGING_DIR));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    for (const name of names.sort()) {
      if (name === RECONCILE_DIR) {
        try {
          for (const key of await fs.readdir(this.abs(`${STAGING_DIR}/${RECONCILE_DIR}`))) this.reconcile.add(key);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOTDIR") throw e;
          // 不是目录（被人为改动过）：删掉，下次打标记时重建
          await fs.rm(this.abs(`${STAGING_DIR}/${RECONCILE_DIR}`), { force: true });
        }
        continue;
      }
      const meta = await this.readStagingMeta(name);
      if (meta) this.stagings.set(name, meta);
      else {
        this.log(`丢弃无法识别的同步暂存 ${STAGING_DIR}/${name}`);
        await fs.rm(this.abs(`${STAGING_DIR}/${name}`), { recursive: true, force: true });
      }
    }
    return [...this.stagings.values()];
  }

  private async readStagingMeta(name: string): Promise<StagingMeta | null> {
    if (!syncIdSchema.safeParse(name).success) return null;
    try {
      const result = stagingMetaSchema.safeParse(JSON.parse(await fs.readFile(this.abs(`${STAGING_DIR}/${name}/meta.json`), "utf8")));
      return result.success && result.data.syncId === name ? result.data : null;
    } catch {
      return null;
    }
  }

  getStaging(syncId: string): StagingMeta | undefined {
    return this.stagings.get(syncId);
  }

  /** 状态为 applying 的暂存，按 committedAt 升序（相同时按 syncId），即应当应用的先后顺序 */
  listApplying(): StagingMeta[] {
    return [...this.stagings.values()]
      .filter((m) => m.state === "applying")
      .sort((a, b) => {
        const diff = Date.parse(a.applying!.committedAt) - Date.parse(b.applying!.committedAt);
        if (diff !== 0) return diff;
        return a.syncId < b.syncId ? -1 : a.syncId > b.syncId ? 1 : 0;
      });
  }

  /** 校验后写 meta.json，写成功才更新内存 */
  async saveStaging(meta: StagingMeta): Promise<void> {
    const valid = parseInput(stagingMetaSchema, meta);
    await writeFileAtomic(this.abs(`${STAGING_DIR}/${valid.syncId}/meta.json`), `${JSON.stringify(valid)}\n`, {
      tmpDir: this.tmpDir,
    });
    this.stagings.set(valid.syncId, valid);
  }

  async removeStaging(syncId: string): Promise<void> {
    await fs.rm(this.abs(`${STAGING_DIR}/${syncIdSchema.parse(syncId)}`), { recursive: true, force: true });
    this.stagings.delete(syncId);
  }

  /** 只从内存里移除（磁盘上的删不掉时用）；留在磁盘上的，下次启动时按状态处理 */
  forgetStaging(syncId: string): void {
    this.stagings.delete(syncId);
  }

  async removeBlob(syncId: string, sha: string): Promise<void> {
    await fs.rm(this.blobPath(syncId, sha), { force: true });
  }

  // ---------- 整体核对标记 ----------

  needsReconcile(projectId: string, machineId: string): boolean {
    return this.reconcile.has(`${projectId}.${machineId}`);
  }

  async markReconcile(projectId: string, machineId: string): Promise<void> {
    const key = `${idSchema.parse(projectId)}.${idSchema.parse(machineId)}`;
    // 先记进内存：写盘失败时，至少本进程运行期间仍会整体核对
    this.reconcile.add(key);
    await writeFileAtomic(this.abs(`${STAGING_DIR}/${RECONCILE_DIR}/${key}`), "", { tmpDir: this.tmpDir });
  }

  async clearReconcile(projectId: string, machineId: string): Promise<void> {
    const key = `${projectId}.${machineId}`;
    if (!this.reconcile.has(key)) return;
    await fs.rm(this.abs(`${STAGING_DIR}/${RECONCILE_DIR}/${key}`), { force: true });
    this.reconcile.delete(key);
  }

  /**
   * 整体核对：对照磁盘上的快照目录与目标清单，找出清单没有描述到的差异——磁盘上多出来的文件
   * （包括挡在目标路径上的杂散文件），以及缺失或内容与清单不符的文件。只读。
   * 只把普通文件当作文件读取；软链接、FIFO、socket 等一律当作要删除的杂散项，不去读它们
   * （读 FIFO 会一直阻塞，读软链接可能读到快照目录之外）。
   */
  async reconcileDiff(projectId: string, machineId: string, target: SnapshotManifest): Promise<{ writes: ManifestFile[]; removed: string[] }> {
    const root = this.abs(snapshotRelDir(projectId, machineId));
    const regular = new Set<string>();
    const strays: string[] = [];
    try {
      for (const e of await fs.readdir(root, { recursive: true, withFileTypes: true })) {
        if (e.isDirectory()) continue;
        const rel = path.relative(root, path.join(e.parentPath, e.name)).split(path.sep).join("/");
        if (!snapshotPathSchema.safeParse(rel).success) continue;
        if (e.isFile()) regular.add(rel);
        else strays.push(rel);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const wanted = new Set(target.files.map((f) => f.path));
    const removed = [...strays, ...[...regular].filter((p) => !wanted.has(p))].sort();
    const writes: ManifestFile[] = [];
    for (const f of target.files) {
      const bytes = regular.has(f.path) ? await readSnapshotEntry(root, f.path) : null;
      if (!bytes || sha256Hex(bytes) !== f.sha256) writes.push(f);
    }
    return { writes, removed };
  }

  /**
   * 删除过期仍为 open 的暂存，以及内存里没有记录的暂存目录（例如提交删掉暂存的同时，
   * 一次上传又把目录建了出来）。
   */
  async removeExpired(nowMs: number): Promise<void> {
    for (const meta of [...this.stagings.values()]) {
      if (meta.state === "open" && Date.parse(meta.expiresAt) <= nowMs) await this.removeStaging(meta.syncId);
    }
    let names: string[];
    try {
      names = await fs.readdir(this.abs(STAGING_DIR));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    for (const name of names) {
      if (name !== RECONCILE_DIR && !this.stagings.has(name)) await fs.rm(this.abs(`${STAGING_DIR}/${name}`), { recursive: true, force: true });
    }
  }

  /** 本项目本机所有没过期、还在等这份内容的 open 暂存 */
  waitingFor(projectId: string, machineId: string, sha: string, nowMs: number): StagingMeta[] {
    return [...this.stagings.values()].filter(
      (m) =>
        m.projectId === projectId &&
        m.machineId === machineId &&
        m.state === "open" &&
        Date.parse(m.expiresAt) > nowMs &&
        m.missing.includes(sha),
    );
  }

  async putBlob(syncId: string, sha: string, bytes: Uint8Array): Promise<void> {
    await writeFileAtomic(this.blobPath(syncId, sha), bytes, { tmpDir: this.tmpDir });
  }

  private blobPath(syncId: string, sha: string): string {
    return this.abs(`${STAGING_DIR}/${syncIdSchema.parse(syncId)}/blobs/${sha256HexSchema.parse(sha)}`);
  }

  /**
   * 把应用需要的内容都放进暂存的 blobs/：已经上传的核对 hash 后使用（不符就删掉）；没有的从本项目
   * 任意机器的快照文件复制，复制前重新核对 hash，不一致就当作缺失。返回缺失的 hash。
   * 先把内容收进暂存，再动快照：应用过程中会删除旧文件，它们可能正是新文件的内容来源；
   * 崩溃后重放也只依赖暂存本身。
   */
  async collectContent(meta: StagingMeta, shas: Iterable<string>): Promise<string[]> {
    const sources = new Map<string, { machineId: string; path: string }[]>();
    for (const manifest of this.listManifests(meta.projectId)) {
      for (const f of manifest.files) {
        const list = sources.get(f.sha256) ?? [];
        list.push({ machineId: manifest.machineId, path: f.path });
        sources.set(f.sha256, list);
      }
    }
    const missing: string[] = [];
    for (const sha of new Set(shas)) {
      const staged = await readOrNull(this.blobPath(meta.syncId, sha));
      if (staged && sha256Hex(staged) === sha) continue;
      if (staged) await this.removeBlob(meta.syncId, sha);
      let found = false;
      for (const source of sources.get(sha) ?? []) {
        const bytes = await readSnapshotEntry(this.abs(snapshotRelDir(meta.projectId, source.machineId)), source.path);
        if (bytes && sha256Hex(bytes) === sha) {
          await this.putBlob(meta.syncId, sha, bytes);
          found = true;
          break;
        }
      }
      if (!found) missing.push(sha);
    }
    return missing.sort();
  }

  /** 检查一批快照路径都落在该机器的快照目录内，不合法时抛 invalid；不改任何东西 */
  assertInside(projectId: string, machineId: string, paths: Iterable<string>): void {
    const root = this.abs(snapshotRelDir(projectId, machineId));
    for (const p of paths) resolveSnapshotPath(root, p);
  }

  /**
   * 改快照目录：先删除清单里已经没有的文件并清理空目录，再写入新增或变化的文件
   * （先删后写，处理“目录 a/ 变成文件 a”这类情况）。内容一律取自暂存的 blobs/，
   * 读出后再核对一次 hash。重复执行结果相同。
   */
  async applyFiles(meta: StagingMeta, writes: readonly ManifestFile[], removed: readonly string[]): Promise<void> {
    const root = this.abs(snapshotRelDir(meta.projectId, meta.machineId));
    for (const p of removed) {
      const target = resolveSnapshotPath(root, p);
      // 某一级父目录不是真正的目录（是文件或软链接）时，这个路径在快照目录里已经不存在；
      // 不能穿过软链接去删快照目录之外的东西
      if (!(await parentsAreRealDirs(root, target))) continue;
      await removeEntry(target);
      await pruneEmptyDirs(root, path.dirname(target));
    }
    for (const f of writes) {
      const target = resolveSnapshotPath(root, f.path);
      const bytes = await readOrNull(this.blobPath(meta.syncId, f.sha256));
      if (!bytes || sha256Hex(bytes) !== f.sha256) throw new BlobMismatchError(f.sha256);
      await clearWayTo(root, target);
      await writeFileAtomic(target, bytes, { tmpDir: this.tmpDir });
    }
  }

  /** 读快照文件：路径必须在该机器的清单里；文件不存在（例如刚被删掉）时返回 null */
  async readFile(projectId: string, machineId: string, rel: string): Promise<Uint8Array | null> {
    const manifest = this.getManifest(projectId, machineId);
    if (!manifest || !manifest.files.some((f) => f.path === rel)) return null;
    const bytes = await readSnapshotEntry(this.abs(snapshotRelDir(projectId, machineId)), rel);
    return bytes && new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private abs(rel: string): string {
    return path.join(this.dataDir, ...rel.split("/"));
  }
}

/** 不跟随最后一级软链接、打开 FIFO 时不阻塞；平台没有对应标志时为 0 */
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

/**
 * 读一个普通文件的全部内容；不存在、不是普通文件（目录、软链接、FIFO、socket 等）时返回 null。
 * 先以不跟随软链接、不阻塞的方式打开，再确认打开的是普通文件才读，读 FIFO 不会卡住。
 */
async function readOrNull(file: string): Promise<Buffer | null> {
  let handle;
  try {
    handle = await fs.open(file, OPEN_FLAGS);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR" || code === "ELOOP" || code === "ENXIO") return null;
    throw e;
  }
  try {
    if (!(await handle.stat()).isFile()) return null;
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/** 读快照目录里的一个文件：路径上任何一级父目录是软链接或不是目录时返回 null，不穿过链接读到外面 */
async function readSnapshotEntry(root: string, rel: string): Promise<Buffer | null> {
  const target = resolveSnapshotPath(root, rel);
  if (!(await parentsAreRealDirs(root, target))) return null;
  return readOrNull(target);
}

/**
 * 删除快照目录里的一项：普通文件和软链接删它本身（不跟随链接），目录连同内容一起删；
 * 已经不存在（包括某一级父路径变成了文件）当作删除完成。
 */
async function removeEntry(target: string): Promise<void> {
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return;
    throw e;
  }
  await fs.rm(target, { recursive: stat.isDirectory(), force: true });
}

/** 从快照根（含）到 target 的父目录，每一级都存在且是真正的目录（不是软链接） */
async function parentsAreRealDirs(root: string, target: string): Promise<boolean> {
  for (const dir of chainFrom(root, path.dirname(target))) {
    const stat = await fs.lstat(dir).catch(() => null);
    if (!stat || !stat.isDirectory()) return false;
  }
  return true;
}

/**
 * 写入 target 之前清出一条路：从快照根（含）到父目录，遇到软链接或文件就当作杂散项删掉
 * （删链接本身），之后的各级由写入时新建；target 本身是目录或软链接时也删掉。
 * 保证写入不会穿过软链接落到快照目录之外。
 */
async function clearWayTo(root: string, target: string): Promise<void> {
  for (const dir of chainFrom(root, path.dirname(target))) {
    const stat = await fs.lstat(dir).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (!stat) break;
    if (stat.isDirectory()) continue;
    await fs.rm(dir, { force: true });
    break;
  }
  const stat = await fs.lstat(target).catch(() => null);
  if (stat && (stat.isDirectory() || stat.isSymbolicLink())) await fs.rm(target, { recursive: stat.isDirectory(), force: true });
}

/** root 以及它下面直到 dir 的每一级目录，从上到下；dir 必须在 root 之内（或就是 root） */
function chainFrom(root: string, dir: string): string[] {
  const rel = path.relative(root, dir);
  const chain = [root];
  if (rel === "") return chain;
  let current = root;
  for (const seg of rel.split(path.sep)) {
    current = path.join(current, seg);
    chain.push(current);
  }
  return chain;
}

/** 从 dir 往上删除空目录，直到 root（不含 root）或遇到非空目录 */
async function pruneEmptyDirs(root: string, dir: string): Promise<void> {
  let current = dir;
  while (current.startsWith(root + path.sep)) {
    try {
      await fs.rmdir(current);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        current = path.dirname(current);
        continue;
      }
      return;
    }
    current = path.dirname(current);
  }
}
