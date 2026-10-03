import fs from "node:fs/promises";
import path from "node:path";
import {
  type PullReportInput,
  type SyncCommitResponse,
  type SyncManifestInput,
  type SyncManifestResponse,
  pullReportInput,
  syncManifestInput,
} from "@kanban-hub/core/api";
import { commitScope } from "@kanban-hub/core/commit";
import { KhError, parseInput } from "@kanban-hub/core/errors";
import { generateId, idSchema } from "@kanban-hub/core/ids";
import * as ops from "@kanban-hub/core/mutations";
import {
  type Actor,
  type Board,
  type Container,
  type ContainerCreateInput,
  type ContainerPatchInput,
  type ContainerReorderInput,
  type DeepReadonly,
  type Event,
  type EventType,
  type LocationInput,
  type LogInput,
  type Project,
  type ProjectCreateInput,
  type ProjectPatchInput,
  type Task,
  type TaskCreateInput,
  type TaskPatchInput,
  type TaskReorderInput,
  actorSchema,
  boardSchema,
  eventSchema,
  projectSchema,
} from "@kanban-hub/core/schema";
import {
  type ManifestFile,
  type SnapshotManifest,
  SYNC_STAGING_TTL_MS,
  applyManifestDiff,
  docsPulledChange,
  docsSyncedChange,
  sha256HexSchema,
  snapshotManifestSchema,
} from "@kanban-hub/core/sync";
import { type ImportSummary, type TransferDoc, importLogKey, planImport, transferDocSchema } from "@kanban-hub/core/transfer";
import { AUTH_DIR, AuthRepo } from "./auth";
import {
  BACKUP_FILE_NAME_RE,
  listBackupFiles,
  writeBackupArchive,
  type BackupFileInfo,
  type CreateBackupOptions,
} from "./backup";
import { type CommitActor, Committer } from "./committer";
import { EventLog, monthOf, recentMonths } from "./events";
import { DataFileError, readYamlFile, writeFileAtomic, writeYamlFile } from "./fsio";
import { GitRepo } from "./git";
import { acquireInstanceLock, INSTANCE_LOCK_FILE, type InstanceLock } from "./instance-lock";
import { WriteQueue } from "./queue";
import {
  type StagingMeta,
  BlobMismatchError,
  STAGING_DIR,
  SnapshotRepo,
  TMP_DIR,
  manifestRelPath,
  newSyncId,
  sha256Hex,
  snapshotRelDir,
  syncIdSchema,
} from "./snapshots";

/**
 * 数据目录的 .gitignore，由程序管理，启动时内容不一致就重写：凭据、同步暂存、原子写的临时文件、
 * 单实例锁都不进 git 历史。只忽略根目录下的这几个目录和锁文件，不按文件名模式忽略——
 * 快照里的文档可以叫任何名字。
 */
export const DATA_GITIGNORE = ["# kanban-hub 数据目录", "/auth/", "/.staging/", "/.tmp/", `/${INSTANCE_LOCK_FILE}`, ""].join("\n");
/**
 * 数据仓库的 .git/info/attributes（优先级高于任何 .gitattributes）：快照里可能带着仓库自己的
 * .gitattributes，其中的换行转换、filter、ident、编码转换会改变提交进数据仓库的内容，这里一律关闭，
 * 保证提交的就是磁盘上的原始字节。diff、merge 只影响显示和合并，不改内容，不在这里关闭。
 */
export const DATA_GIT_ATTRIBUTES = "* -text -eol -crlf -filter -ident -working-tree-encoding\n";
/** 启动时读进内存的事件月份数（规格 6.2） */
export const RECENT_EVENT_MONTHS = 3;
/** 关闭时等待写入队列和提交的上限。要小于关机宽限 SHUTDOWN_GRACE_MS（8 秒），外层超时层级见该常量的注释 */
export const CLOSE_TIMEOUT_MS = 5_000;

export interface StoreOptions {
  dataDir: string;
  /** 备份目录；默认是数据目录旁边的 backups（Docker 里就是 /data 旁的 /backups） */
  backupDir?: string;
  now?: () => Date;
  newId?: () => string;
  commitDebounceMs?: number;
  gitBin?: string;
  /** 单次 git 调用的时间上限，默认见 GIT_TIMEOUT_MS */
  gitTimeoutMs?: number;
  log?: (message: string) => void;
}

export interface ProjectState {
  project: Project;
  board: Board;
}

/** 一次写操作产生的事件，推给订阅者（M2 的 SSE 用） */
export interface StoreChange {
  projectId: string;
  events: Event[];
}

/** 事件翻页游标：排序键是 (ts, id) */
export interface EventCursor {
  ts: string;
  id: string;
}

export interface EventQuery {
  projectId?: string;
  before?: EventCursor;
  limit: number;
  types?: EventType[];
  /** "web" 匹配 actor.via === "web"；其余值按机器 ID 匹配 actor.machineId */
  actor?: "web" | string;
}

export interface MutationOptions {
  /** 网页请求带上的版本号，与当前版本不一致时报 conflict */
  expectedVersion?: number;
}

/** 一次写入要落盘的内容：可选的新项目、新看板，以及要追加的事件 */
interface WriteChange {
  projectId: string;
  project?: Project;
  board?: Board;
  events: Event[];
}

interface Outcome<T> extends WriteChange {
  value: T;
}

export interface ImportOptions {
  /** 只计算、不写入 */
  dryRun: boolean;
}

/** 与 apps/web/src/lib/board.ts 的 byOrder 同口径：order、createdAt、id */
function byOrder(a: { order: number; createdAt: string; id: string }, b: { order: number; createdAt: string; id: string }): number {
  return a.order - b.order || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

export class Store {
  readonly auth: AuthRepo;
  private readonly queue = new WriteQueue();
  private readonly git: GitRepo;
  private readonly committer: Committer;
  private readonly eventLog: EventLog;
  private readonly snapshots: SnapshotRepo;
  private readonly tmpDir: string;
  private readonly projects = new Map<string, ProjectState>();
  /** 内存里的事件：windowStart 及以后月份的全部事件（规格 6.2） */
  private readonly recentEvents: Event[] = [];
  private windowStart = "";
  private readonly lastEventAt = new Map<string, string>();
  private readonly listeners = new Set<(change: StoreChange) => void>();
  private closing = false;
  /** 备份是否在创建中（已排队或正在打包），API 用它立即拒绝并发创建 */
  private backingUp = false;
  /** 单实例锁：open 时拿到，close 时释放。别的进程持有同一数据目录时 open 直接失败 */
  private lock: InstanceLock | null = null;
  private readonly backupDir: string;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly log: (message: string) => void;

  private constructor(
    private readonly dataDir: string,
    opts: StoreOptions,
  ) {
    this.now = opts.now ?? (() => new Date());
    this.newId = opts.newId ?? (() => generateId());
    this.log = opts.log ?? ((m) => console.warn(`[kanban-hub] ${m}`));
    this.backupDir = opts.backupDir ?? path.join(path.dirname(dataDir), "backups");
    this.tmpDir = path.join(dataDir, TMP_DIR);
    this.git = new GitRepo(dataDir, opts.gitBin, { timeoutMs: opts.gitTimeoutMs });
    this.eventLog = new EventLog(dataDir);
    this.snapshots = new SnapshotRepo(dataDir, this.tmpDir, this.log);
    this.auth = new AuthRepo(dataDir, this.queue, { now: this.now, newId: this.newId, tmpDir: this.tmpDir });
    this.committer = new Committer({
      git: this.git,
      runExclusive: (job) => this.queue.run(job),
      debounceMs: opts.commitDebounceMs,
      log: this.log,
    });
  }

  /**
   * 打开数据目录。数据文件有问题时抛出 DataFileError（带文件和行号）；
   * 数据目录已被别的存活进程占用时抛出 conflict，加载失败时释放已拿到的锁再抛。
   */
  static async open(opts: StoreOptions): Promise<Store> {
    const store = new Store(opts.dataDir, opts);
    // 锁在加载之前拿：加载会写数据目录（建 git 仓库、补提交），不能和另一个进程并发
    store.lock = await acquireInstanceLock(opts.dataDir);
    try {
      await store.load();
    } catch (e) {
      // 打开失败时进程还活着，锁不会有人来接管，必须自己释放
      await store.lock.release().catch(() => {});
      store.lock = null;
      throw e;
    }
    return store;
  }

  /** 数据目录的绝对路径，供设置页显示 */
  get dataDirectory(): string {
    return this.dataDir;
  }

  // ---------- 查询（读内存，同步） ----------

  listProjects(): DeepReadonly<Project[]> {
    return [...this.projects.values()].map((s) => s.project);
  }

  getProject(id: string): DeepReadonly<Project> | undefined {
    return this.projects.get(id)?.project;
  }

  getBoard(projectId: string): DeepReadonly<Board> | undefined {
    return this.projects.get(projectId)?.board;
  }

  findProjectsByFingerprint(fingerprint: string): DeepReadonly<Project[]> {
    return this.listProjects().filter((p) => p.fingerprint === fingerprint);
  }

  /** 项目最后一条事件的时间，停滞判定用 */
  getLastEventAt(projectId: string): string | null {
    return this.lastEventAt.get(projectId) ?? null;
  }

  /**
   * 各项目在内存窗口里最新的一条事件；只读 recentEvents，不进写入队列，不读历史文件
   * （比对每个项目分别调 listEvents 便宜得多，项目卡片的“最近活动”用它）。
   * 内存窗口里没有事件的项目不出现在结果里。同一时刻的多条事件，按与 lib/events.ts 的
   * sortEventsForDisplay 一致的次级顺序取最新一条：*.created → *.updated →
   * task.status_changed → task.human_changed → 其他，最后按 id 兜底。
   */
  latestEventPerProject(): Map<string, DeepReadonly<Event>> {
    const result = new Map<string, DeepReadonly<Event>>();
    for (const event of this.recentEvents) {
      const current = result.get(event.projectId);
      if (!current || isLaterEvent(event, current)) result.set(event.projectId, event);
    }
    return result;
  }

  /** 某台机器在这个项目上的快照清单；还没同步过时返回 null */
  getSnapshotManifest(projectId: string, machineId: string): DeepReadonly<SnapshotManifest> | null {
    return this.snapshots.getManifest(projectId, machineId);
  }

  /** 这个项目所有机器的快照清单，按机器 ID 排序 */
  listSnapshotManifests(projectId: string): DeepReadonly<SnapshotManifest>[] {
    return this.snapshots.listManifests(projectId);
  }

  /**
   * 读一个快照文件的内容。路径必须在该机器的清单里，否则返回 null；文件在读取前一刻
   * 被同步删掉时也返回 null。只读，不进写入队列。
   */
  readSnapshotFile(projectId: string, machineId: string, filePath: string): Promise<Uint8Array | null> {
    return this.snapshots.readFile(projectId, machineId, filePath);
  }

  /** 待提交到 git 的文件数 */
  pendingCommitCount(): number {
    return this.committer.pendingCount();
  }

  subscribe(listener: (change: StoreChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 按时间倒序列出事件；内存里不够时，再按月份从新到旧读更早的文件（规格 6.2） */
  async listEvents(query: EventQuery): Promise<DeepReadonly<Event[]>> {
    // 项目不存在时拒绝，且必须在内存过滤和读文件之前：query.projectId 不检查就拼进文件路径，
    // 会把不存在的（或路径穿越的）ID 拼出数据目录外的路径去读（M2 把 not_found 映射成 404）
    if (query.projectId !== undefined && !this.projects.has(query.projectId)) {
      throw new KhError("not_found", "项目不存在");
    }
    const matches = (e: Event) =>
      (query.projectId === undefined || e.projectId === query.projectId) &&
      (query.before === undefined || compareEvents(e, query.before) < 0) &&
      (query.types === undefined || query.types.includes(e.type)) &&
      (query.actor === undefined || matchesActor(e.actor, query.actor));
    const result = this.recentEvents.filter(matches).sort(newestFirst).slice(0, query.limit);
    if (result.length >= query.limit) return result;
    // 列目录是只读操作，不经过写入队列（不会和写入冲突）；这里只用来决定要不要排队，
    // 不作为最终读取依据——拿到队列独占权之后会重新列一遍，见下方
    const projectIds = query.projectId !== undefined ? [query.projectId] : [...this.projects.keys()];
    if (!(await this.hasMonthsBeforeWindow(projectIds))) return result;
    // 读旧文件时可能顺带修复残行，放进写入队列，避免和追加事件交错。进队列后重新取一遍内存里的
    // 事件、重新列一遍月份，而不是直接复用上面的结果：排队期间可能有写入（例如导入历史事件）
    // 追加了新的事件或新的旧月份文件，队列外的判断只用来避免内存已经够用时无谓地排队等待
    return this.queue.run(async () => {
      const merged = this.recentEvents.filter(matches).sort(newestFirst);
      const byMonth = await this.monthsBeforeWindow(projectIds);
      for (const month of [...byMonth.keys()].sort().reverse()) {
        if (merged.length >= query.limit) break;
        const batch: Event[] = [];
        for (const id of byMonth.get(month)!) {
          for (const event of await this.readMonthLocked(id, month)) if (matches(event)) batch.push(event);
        }
        for (const event of batch.sort(newestFirst)) merged.push(event);
      }
      return merged.slice(0, query.limit);
    });
  }

  /**
   * 项目全部月份的 log 事件，按 (ts, id) 升序，供导出使用。读文件时可能顺带修复残行（会写文件），
   * 所以和 listEvents 读旧文件时一样进写入队列。
   */
  async readProjectLogs(projectId: string): Promise<Event[]> {
    // 先确认项目存在，再拼文件路径（与 listEvents 相同的路径穿越防护）
    this.requireProject(projectId);
    return this.queue.run(async () => {
      const events = await this.readProjectEventsLocked(projectId);
      return events.filter((e) => e.type === "log").sort(compareEvents);
    });
  }

  /** 是否存在早于内存窗口的事件月份文件；只读目录，供 listEvents 决定要不要排队 */
  private async hasMonthsBeforeWindow(projectIds: readonly string[]): Promise<boolean> {
    for (const id of projectIds) {
      for (const month of await this.eventLog.listMonths(id)) {
        if (month < this.windowStart) return true;
      }
    }
    return false;
  }

  /** 早于内存窗口的月份 → 该月有事件的项目 ID 列表；只读目录，不做任何假设地重新列一遍 */
  private async monthsBeforeWindow(projectIds: readonly string[]): Promise<Map<string, string[]>> {
    const byMonth = new Map<string, string[]>();
    for (const id of projectIds) {
      for (const month of await this.eventLog.listMonths(id)) {
        if (month < this.windowStart) byMonth.set(month, [...(byMonth.get(month) ?? []), id]);
      }
    }
    return byMonth;
  }

  // ---------- 写操作（经过写入队列） ----------

  createProject(input: ProjectCreateInput, actor: Actor): Promise<ProjectState> {
    return this.mutate(actor, (ctx) => {
      const r = ops.createProject(input, ctx);
      return { projectId: r.project.id, project: r.project, board: r.board, events: r.events, value: { project: r.project, board: r.board } };
    });
  }

  updateProject(projectId: string, patch: ProjectPatchInput, actor: Actor, opts: MutationOptions = {}): Promise<Project> {
    return this.mutate(actor, (ctx) => {
      const r = ops.updateProject(this.requireProject(projectId).project, patch, ctx, opts.expectedVersion);
      return { projectId, project: r.project, events: r.events, value: r.project };
    });
  }

  setLocation(projectId: string, machineId: string, input: LocationInput, actor: Actor): Promise<Project> {
    return this.mutate(actor, (ctx) => {
      const state = this.requireProject(projectId);
      if (!this.auth.getMachine(machineId)) throw new KhError("not_found", `机器 ${machineId} 不存在`);
      const r = ops.setLocation(state.project, machineId, input, ctx);
      return { projectId, project: r.project, events: r.events, value: r.project };
    });
  }

  createContainer(projectId: string, input: ContainerCreateInput, actor: Actor): Promise<Container> {
    return this.mutate(actor, (ctx) => {
      const r = ops.createContainer(this.requireProject(projectId).board, projectId, input, ctx);
      return { projectId, board: r.board, events: r.events, value: r.container };
    });
  }

  updateContainer(
    projectId: string,
    containerId: string,
    patch: ContainerPatchInput,
    actor: Actor,
    opts: MutationOptions = {},
  ): Promise<Container> {
    return this.mutate(actor, (ctx) => {
      const board = this.requireProject(projectId).board;
      const r = ops.updateContainer(board, projectId, containerId, patch, ctx, opts.expectedVersion);
      return { projectId, board: r.board, events: r.events, value: r.container };
    });
  }

  /** 重排容器内的任务，返回该容器按新顺序排列的全部任务；顺序不变时不写入 */
  reorderTasks(projectId: string, containerId: string, input: TaskReorderInput, actor: Actor): Promise<Task[]> {
    return this.mutate(actor, (ctx) => {
      const r = ops.reorderTasks(this.requireProject(projectId).board, projectId, containerId, input, ctx);
      const value = r.board.tasks.filter((t) => t.containerId === containerId).sort(byOrder);
      return { projectId, board: r.board, events: r.events, value };
    });
  }

  /** 重排非杂项容器，返回按新顺序排列的全部容器，杂项容器在最后 */
  reorderContainers(projectId: string, input: ContainerReorderInput, actor: Actor): Promise<Container[]> {
    return this.mutate(actor, (ctx) => {
      const r = ops.reorderContainers(this.requireProject(projectId).board, projectId, input, ctx);
      const value = [...r.board.containers.filter((c) => c.kind !== "misc").sort(byOrder), ...r.board.containers.filter((c) => c.kind === "misc")];
      return { projectId, board: r.board, events: r.events, value };
    });
  }

  createTask(projectId: string, input: TaskCreateInput, actor: Actor): Promise<Task> {
    return this.mutate(actor, (ctx) => {
      const r = ops.createTask(this.requireProject(projectId).board, projectId, input, ctx);
      return { projectId, board: r.board, events: r.events, value: r.task };
    });
  }

  updateTask(projectId: string, taskId: string, patch: TaskPatchInput, actor: Actor, opts: MutationOptions = {}): Promise<Task> {
    return this.mutate(actor, (ctx) => {
      const board = this.requireProject(projectId).board;
      const r = ops.updateTask(board, projectId, taskId, patch, ctx, opts.expectedVersion);
      return { projectId, board: r.board, events: r.events, value: r.task };
    });
  }

  appendLog(projectId: string, input: LogInput, actor: Actor): Promise<Event> {
    return this.mutate(actor, (ctx) => {
      const event = ops.createLogEvent(this.requireProject(projectId).board, projectId, input, ctx);
      return { projectId, events: [event], value: event };
    });
  }

  /**
   * 文档同步第一步：登记一份清单，返回服务端还缺少的内容。
   * 缺少的内容是本项目任意机器当前清单里都没有出现过的 sha256；顺手清理过期的暂存。
   */
  beginSync(projectId: string, machineId: string, input: SyncManifestInput): Promise<SyncManifestResponse> {
    if (this.closing) return Promise.reject(new KhError("unavailable", "服务正在关闭，请稍后重试"));
    return this.queue.run(async () => {
      const state = this.requireProject(projectId);
      if (!state.project.locations.some((l) => l.machineId === machineId)) {
        throw new KhError("not_found", "本机没有登记这个项目的位置，请执行 kh register");
      }
      const data = parseInput(syncManifestInput, input);
      const now = this.now();
      await this.snapshots.removeExpired(now.getTime());
      const known = this.snapshots.knownHashes(projectId);
      const missing = [...new Set(data.files.map((f) => f.sha256))].filter((h) => !known.has(h)).sort();
      const meta: StagingMeta = {
        syncId: newSyncId(),
        projectId,
        machineId,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + SYNC_STAGING_TTL_MS).toISOString(),
        state: "open",
        missing,
        input: data,
        applying: null,
      };
      await this.snapshots.saveStaging(meta);
      return { syncId: meta.syncId, missing, expiresAt: meta.expiresAt };
    });
  }

  /**
   * 文档同步第二步：上传一份缺少的内容，写进本项目本机所有还在等它的暂存。
   * 不进写入队列：暂存不是数据，写入本身是原子的。
   */
  async putSyncBlob(projectId: string, machineId: string, sha256: string, bytes: Uint8Array): Promise<void> {
    if (!sha256HexSchema.safeParse(sha256).success) throw new KhError("invalid", "内容的 hash 必须是 64 位小写十六进制的 sha256");
    if (sha256Hex(bytes) !== sha256) throw new KhError("invalid", "上传内容的 sha256 与地址里的 hash 不一致");
    const targets = this.snapshots.waitingFor(projectId, machineId, sha256, this.now().getTime());
    if (targets.length === 0) throw new KhError("invalid", "没有等待这份内容的同步");
    for (const meta of targets) await this.snapshots.putBlob(meta.syncId, sha256, bytes);
  }

  /**
   * 文档同步第三步：在写入队列里应用暂存。先核对所需内容全部可用，不齐时什么都不改，
   * 返回 invalid（details.missingBlobs），暂存保持 open；齐了之后标记 applying，
   * 依次改快照、写清单、更新位置、有变化时记 docs.synced，最后标记 applied 并删除暂存。
   */
  commitSync(projectId: string, machineId: string, syncId: string, actor: Actor): Promise<SyncCommitResponse> {
    if (this.closing) return Promise.reject(new KhError("unavailable", "服务正在关闭，请稍后重试"));
    return this.queue.run(async () => {
      const validActor = parseInput(actorSchema, actor);
      const meta = syncIdSchema.safeParse(syncId).success ? this.snapshots.getStaging(syncId) : undefined;
      const now = this.now();
      if (
        !meta ||
        meta.projectId !== projectId ||
        meta.machineId !== machineId ||
        meta.state !== "open" ||
        Date.parse(meta.expiresAt) <= now.getTime()
      ) {
        throw new KhError("not_found", "同步会话不存在或已过期");
      }
      // 这台机器之前有没应用完的同步（运行期间中途失败）时，先按与启动时相同的方式把它们应用完，
      // 这次的差异才是相对真实的快照状态计算的；应用不完就拒绝，不能越过它们
      if (!(await this.replayApplying(projectId, machineId, now.getTime()))) {
        throw new KhError("unavailable", "上一次同步还没有应用完成，请稍后重试");
      }
      const committedAt = now.toISOString();
      const eventId = this.newId();
      const plan = await this.preparePlan(meta, committedAt, validActor, null, eventId);

      // 核对内容齐全之前不改任何东西（收进暂存的内容不算改动）
      const missing = await this.snapshots.collectContent(meta, plan.writes.map((f) => f.sha256));
      if (missing.length > 0) {
        // 清单里有、快照文件却读不对的内容算来源损坏：记下来，之后的 manifest 不再把它当作已有；
        // kh 本来就还没上传的不算。缺失的内容都并入 missing，允许这份暂存补传
        const known = this.snapshots.knownHashes(projectId);
        this.snapshots.markCorrupt(projectId, missing.filter((h) => known.has(h)));
        await this.snapshots.saveStaging({ ...meta, missing: [...new Set([...meta.missing, ...missing])].sort() });
        throw missingContentError(missing);
      }

      const applying: StagingMeta = {
        ...meta,
        state: "applying",
        applying: { committedAt, actor: validActor, eventId, counts: plan.counts },
      };
      await this.snapshots.saveStaging(applying);
      let appended: Event[];
      try {
        appended = await this.runApply(applying, plan, false);
      } catch (e) {
        if (!(e instanceof BlobMismatchError)) throw e;
        await this.reopenStaging(applying, [e.sha]);
        throw missingContentError([e.sha]);
      }
      // 没有变化时也通知：网页据此刷新同步时间
      await this.finishStaging(applying, () => this.emit({ projectId, events: appended }));
      return { ...plan.counts, lastSyncAt: committedAt };
    });
  }

  /**
   * 按导入文件更新项目（规格 10.4）：整个过程是写入队列里的一个任务。读出项目已有的全部 log 事件
   * 算去重键，交给 planImport 算出新的项目、看板和要追加的事件；dryRun 时只返回摘要。
   * 没有变化时不写文件、不记事件、不提交。写入与普通写操作走同一段落盘逻辑，
   * 只把 import.applied 推给订阅者（历史日志可能有几千条，网页收到通知后会重新拉取）。
   */
  applyImport(projectId: string, doc: TransferDoc, actor: Actor, opts: ImportOptions): Promise<ImportSummary> {
    if (this.closing) return Promise.reject(new KhError("unavailable", "服务正在关闭，请稍后重试"));
    return this.queue.run(async () => {
      const state = this.requireProject(projectId);
      const validActor = parseInput(actorSchema, actor);
      const data = parseInput(transferDocSchema, doc);
      // 已经持有队列：只能用不排队的内部读取，调用 listEvents / readProjectLogs 会互相等待
      const events = await this.readProjectEventsLocked(projectId);
      const logKeys = new Set(events.filter((e) => e.type === "log").map((e) => importLogKey(e.ts, e.text ?? "")));
      const ctx: ops.MutationContext = { now: this.now().toISOString(), actor: validActor, newId: this.newId };
      const plan = planImport(state, data, logKeys, ctx);
      const summary: ImportSummary = { dryRun: opts.dryRun, ...plan.summary };
      if (opts.dryRun || plan.events.length === 0) return summary;
      await this.writeChange(
        validActor,
        { projectId, project: plan.project ?? undefined, board: plan.board ?? undefined, events: plan.events },
        (appended) => appended.filter((e) => e.type === "import.applied"),
      );
      return summary;
    });
  }

  /** 记一次拉取的结果：追加一条 docs.pulled */
  async recordPull(projectId: string, input: PullReportInput, actor: Actor): Promise<void> {
    await this.mutate(actor, (ctx) => {
      this.requireProject(projectId);
      const data = parseInput(pullReportInput, input);
      const event = docsEvent(ctx, projectId, "docs.pulled", docsPulledChange(data, data.fromMachineIds));
      return { projectId, events: [event], value: undefined };
    });
  }

  /** 关机：停止接收写入，等写入队列跑完，再提交全部待提交的改动，最后释放单实例锁。超时返回 false */
  async close(timeoutMs = CLOSE_TIMEOUT_MS): Promise<boolean> {
    this.closing = true;
    const done = await withTimeout(
      this.queue.run(() => this.committer.flushNow()),
      timeoutMs,
      false,
    );
    this.committer.close();
    // 锁放在提交全部完成之后释放：释放后别的进程就能打开并接管这个目录，得是数据都落盘之后。
    // 释放失败不改变 close 的结果（它只反映提交是否完成），残留的锁会被下次启动按死进程接管消化
    try {
      await this.lock?.release();
    } catch (e) {
      this.log(`释放单实例锁失败：${(e as Error).message}`);
    }
    this.lock = null;
    return done;
  }

  // ---------- 备份 ----------

  /**
   * 创建备份（规格 6.4、6.6）：打包作为写入队列里的一项执行，打包期间写入自然暂停；
   * 打包之前先立即提交一次待提交的改动，备份里的 git 历史因此是完整的。
   */
  createBackup(opts: CreateBackupOptions = {}): Promise<BackupFileInfo> {
    if (this.closing) return Promise.reject(new KhError("unavailable", "服务正在关闭，请稍后重试"));
    // 排队就算进行中：并发的第二个请求要立即拿到 409，而不是排队之后再打一份
    this.backingUp = true;
    return this.queue.run(async () => {
      try {
        await this.committer.flushNow();
        return await writeBackupArchive(this.dataDir, this.backupDir, opts);
      } finally {
        this.backingUp = false;
      }
    });
  }

  /** 备份是否在创建中（含排队等待），供创建接口立即拒绝并发请求 */
  backupRunning(): boolean {
    return this.backingUp;
  }

  /** 列出备份目录里的备份文件，按创建时间倒序 */
  listBackups(): BackupFileInfo[] {
    return listBackupFiles(this.backupDir);
  }

  /** 读一份备份文件的内容，供下载。文件名先过约定正则，挡住路径穿越 */
  async readBackupFile(fileName: string): Promise<Uint8Array> {
    if (!BACKUP_FILE_NAME_RE.test(fileName)) throw new KhError("not_found", "备份文件不存在");
    try {
      return new Uint8Array(await fs.readFile(path.join(this.backupDir, fileName)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new KhError("not_found", "备份文件不存在");
      throw e;
    }
  }

  // ---------- 内部 ----------

  private async load(): Promise<void> {
    const created = await this.git.init();
    // 进程在 git 提交途中被强杀会留下锁文件；数据目录只有本服务在写，启动时不会有别的 git 进程在运行
    await this.git.removeStaleLocks();
    // 临时文件只在一次原子写入的过程中存在，启动时留下的都是上次崩溃的残余
    await fs.rm(this.tmpDir, { recursive: true, force: true });
    await fs.mkdir(this.tmpDir, { recursive: true });
    await removeLegacyTmpFiles(this.dataDir);
    await this.writeIfChanged(".gitignore", DATA_GITIGNORE);
    await this.writeIfChanged(".git/info/attributes", DATA_GIT_ATTRIBUTES);
    await this.auth.load();
    // 启动过程只取一次当前时间
    const startedAt = this.now();
    this.windowStart = recentMonths(startedAt, RECENT_EVENT_MONTHS)[0]!;
    for (const id of await this.listProjectDirs()) await this.loadProject(id);
    // 在补提交之前处理上次留下的同步暂存，重放产生的改动进同一次补提交
    await this.recoverStagings(startedAt.getTime());
    // 规格 6.5：上次退出前没来得及提交的改动（包括加载时修复的事件文件残行）补一次提交。
    // 提交失败不影响数据，也不阻止启动（规格第 15 节）；改动留在工作区，下次启动时再补
    try {
      // auth/ 显式排除，不依赖 .gitignore：它一旦被改动或丢失（例如从备份还原），
      // 凭据文件就会靠这一层兜底而不是进 git 历史。projects/ 强制纳入：快照里可能带着
      // 仓库自己的 .gitignore，它的规则不能让快照文件漏提交
      await this.git.commitAll(created ? "初始化数据目录" : "补提交上次未提交的改动", [AUTH_DIR], ["projects"]);
    } catch (e) {
      this.log(`启动时补提交失败，改动留在工作区：${(e as Error).message}`);
    }
  }

  private async listProjectDirs(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.abs("projects"), { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory() && idSchema.safeParse(e.name).success)
        .map((e) => e.name)
        .sort();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }

  private async loadProject(id: string): Promise<void> {
    const projectFile = this.abs(projectPath(id));
    const project = await readYamlFile(projectFile, projectSchema);
    if (!project) {
      // 新建项目时先写 board.yaml 再写 project.yaml：两次写入之间崩溃，只会留下没有 project.yaml 的目录
      this.log(`跳过没有 project.yaml 的目录 projects/${id}`);
      return;
    }
    if (project.id !== id) throw new DataFileError(projectFile, null, `id（${project.id}）与所在目录名（${id}）不一致`);
    const boardFile = this.abs(boardPath(id));
    const board = await readYamlFile(boardFile, boardSchema);
    if (!board) throw new DataFileError(boardFile, null, "文件不存在");
    this.projects.set(id, { project, board });
    await this.snapshots.loadManifests(id);

    const months = await this.eventLog.listMonths(id);
    for (const month of months.filter((m) => m >= this.windowStart)) {
      for (const event of await this.eventLog.readMonth(id, month)) this.remember(event);
    }
    // 最近 3 个月没有事件时，停滞判定仍然需要最后一条事件的时间
    const latest = months.at(-1);
    if (!this.lastEventAt.has(id) && latest !== undefined) {
      for (const event of await this.eventLog.readMonth(id, latest)) this.touchLastEvent(event);
    }
  }

  /**
   * 写进数据目录的内容，写之前都要按加载时用的同一套 schema 校验一遍：
   * 保证写得进去的东西，下次一定能按同样的 schema 加载回来（加载时逐行严格校验，见 load/loadProject）。
   */
  private mutate<T>(actor: Actor, compute: (ctx: ops.MutationContext) => Outcome<T>): Promise<T> {
    if (this.closing) return Promise.reject(new KhError("unavailable", "服务正在关闭，请稍后重试"));
    return this.queue.run(async () => {
      // 操作者也是要落盘的内容（写进每条事件）：这里校验会 trim agent，之后统一用校验后的 validActor
      const validActor = parseInput(actorSchema, actor);
      const ctx: ops.MutationContext = { now: this.now().toISOString(), actor: validActor, newId: this.newId };
      const out = compute(ctx);
      // 没有变化：不写文件、不记事件、不通知
      if (out.events.length === 0) return out.value;
      await this.writeChange(validActor, out);
      return out.value;
    });
  }

  /**
   * 普通写操作与导入共用的落盘步骤：校验 → 提交前处理 → 写看板、项目 → 替换内存 → 追加事件 →
   * 登记提交 → 通知。只能在已经持有写入队列的任务里调用；actor 必须是校验过的。
   * notify 从成功追加的事件里挑出要推给订阅者的那些，默认全部推送。
   */
  private async writeChange(
    validActor: Actor,
    out: WriteChange,
    notify: (appended: Event[]) => Event[] = (appended) => appended,
  ): Promise<void> {
    // 只校验、不替换写入的对象；校验失败时在写文件之前就抛出，什么都不写、内存不变
    if (out.project) parseInput(projectSchema, out.project);
    if (out.board) parseInput(boardSchema, out.board);
    for (const event of out.events) parseInput(eventSchema, event);

    const commitActor = this.commitActor(validActor);
    const files = [
      ...(out.board ? [boardPath(out.projectId)] : []),
      ...(out.project ? [projectPath(out.projectId)] : []),
      ...new Set(out.events.map((e) => this.eventLog.relPath(e.projectId, monthOf(e.ts)))),
    ];
    // 必须在写文件之前：这些文件有别的操作者的待提交改动时，先提交掉，
    // 否则那一组提交会把这次写入的内容一起暂存进去
    await this.committer.beforeWrite(commitActor, files);
    // 先写 board.yaml 再写 project.yaml：新建项目时两次写入之间崩溃，只会留下没有 project.yaml 的目录，加载时跳过
    if (out.board) await writeYamlFile(this.abs(boardPath(out.projectId)), out.board, { tmpDir: this.tmpDir });
    if (out.project) await writeYamlFile(this.abs(projectPath(out.projectId)), out.project, { tmpDir: this.tmpDir });
    // 文件都写成功后再替换内存，写失败时内存与磁盘保持一致
    const prev = this.projects.get(out.projectId);
    const project = out.project ?? prev?.project;
    const board = out.board ?? prev?.board;
    if (project && board) this.projects.set(out.projectId, { project, board });

    // 到这里 project.yaml / board.yaml（如果有）已经写入成功：修改就算生效（与规格第 15 节对 git
    // 失败的处理一致，“数据文件不受影响”）。事件追加失败只记日志、不向调用方抛错，避免调用方以为
    // 修改失败而重试——重试会在已经生效的基础上再建一遍，产生重复的项目/任务。remember 只记成功写入
    // 的事件；track 和 emit 无论追加是否失败都执行，emit 带上成功写入的事件，一条都没写进去时也照常
    // 通知，订阅者据此知道这个项目变了。
    const appended: Event[] = [];
    for (const event of out.events) {
      try {
        await this.eventLog.append(event);
        appended.push(event);
      } catch (e) {
        const missing = out.events.length - appended.length;
        this.log(`项目 ${out.projectId} 的修改已保存，但时间线缺少 ${missing} 条事件：${(e as Error).message}`);
        break;
      }
    }
    for (const event of appended) this.remember(event);
    await this.committer.track(commitActor, files, out.events.map((e) => e.type));
    this.emit({ projectId: out.projectId, events: notify(appended) });
  }

  /**
   * 算出应用一份暂存要做的事，只计算、不改任何东西：清单差异、要写入和删除的快照文件、
   * 更新后的项目、要追加的事件、要登记提交的文件。所有路径和写入的对象在这里校验，
   * 不合法时在改动之前就抛出。counts 为 null 时按差异计算（第一次应用），重放时沿用暂存里记下的计数。
   */
  private planSync(meta: StagingMeta, committedAt: string, actor: Actor, counts: SyncCounts | null, eventId: string): SyncPlan {
    const { projectId, machineId } = meta;
    const state = this.requireProject(projectId);
    const diff = applyManifestDiff(this.snapshots.getManifest(projectId, machineId), meta.input.files, machineId, committedAt);
    parseInput(snapshotManifestSchema, diff.next);
    const byPath = new Map(diff.next.files.map((f) => [f.path, f] as const));
    const writes = [...diff.added, ...diff.modified].map((p) => byPath.get(p)!);
    this.snapshots.assertInside(projectId, machineId, [...writes.map((f) => f.path), ...diff.removed]);

    const ctx: ops.MutationContext = { now: committedAt, actor, newId: this.newId };
    const location = { lastSyncAt: committedAt, git: meta.input.git, sync: meta.input.scope, skippedFiles: meta.input.skipped };
    const current = state.project.locations.find((l) => l.machineId === machineId);
    const unchangedLocation =
      current !== undefined &&
      current.lastSyncAt === location.lastSyncAt &&
      sameJson(current.git, location.git) &&
      sameJson(current.sync, location.sync) &&
      sameJson(current.skippedFiles, location.skippedFiles);
    // 重放时位置可能已经更新过：不再改版本号，结果与一次应用相同
    const project = unchangedLocation ? null : ops.recordLocationSync(state.project, machineId, location, ctx).project;

    const finalCounts = counts ?? {
      added: diff.added.length,
      modified: diff.modified.length,
      removed: diff.removed.length,
      unchanged: diff.unchanged,
    };
    // 没有新增、修改、删除时不记事件，位置照常更新
    const event =
      finalCounts.added + finalCounts.modified + finalCounts.removed > 0
        ? parseInput(eventSchema, docsEvent({ ...ctx, newId: () => eventId }, projectId, "docs.synced", docsSyncedChange(finalCounts)))
        : null;

    const snapshotDir = snapshotRelDir(projectId, machineId);
    const files = [
      ...writes.map((f) => `${snapshotDir}/${f.path}`),
      ...diff.removed.map((p) => `${snapshotDir}/${p}`),
      manifestRelPath(projectId, machineId),
      ...(project ? [projectPath(projectId)] : []),
      ...(event ? [this.eventLog.relPath(projectId, monthOf(event.ts))] : []),
    ];
    return { manifest: diff.next, writes, removed: diff.removed, project, event, counts: finalCounts, files, reconciled: false };
  }

  /**
   * 按 planSync 的结果改快照、写清单、更新位置、追加事件，返回成功追加的事件。每一步都可以重做：
   * 快照和清单的写入按目标内容覆盖；位置已经是目标值时 plan.project 为 null；
   * 重放时先确认事件还没追加过。
   */
  private async applySync(meta: StagingMeta, plan: SyncPlan, replay: boolean): Promise<Event[]> {
    const { projectId } = meta;
    await this.snapshots.applyFiles(meta, plan.writes, plan.removed);
    await this.snapshots.writeManifest(projectId, plan.manifest);
    if (plan.project) {
      await writeYamlFile(this.abs(projectPath(projectId)), plan.project, { tmpDir: this.tmpDir });
      const prev = this.requireProject(projectId);
      this.projects.set(projectId, { project: plan.project, board: prev.board });
    }
    const event = plan.event;
    if (!event) return [];
    if (replay && (await this.eventLog.readMonth(projectId, monthOf(event.ts))).some((e) => e.id === event.id)) return [];
    // 与 mutate 一致：快照、清单、位置都已生效，事件追加失败只记日志
    try {
      await this.eventLog.append(event);
    } catch (e) {
      this.log(`项目 ${projectId} 的文档同步已保存，但时间线缺少这条事件：${(e as Error).message}`);
      return [];
    }
    this.remember(event);
    return [event];
  }

  /**
   * 改快照的部分：登记提交之前先处理重叠，然后 applySync。无论成功还是中途失败，都把涉及的
   * 文件登记到这个操作者的分组，已经写入的改动随这一组提交（没改到的路径暂存时没有差异）。
   */
  private async runApply(meta: StagingMeta, plan: SyncPlan, replay: boolean): Promise<Event[]> {
    const commitActor = this.commitActor(meta.applying!.actor);
    await this.committer.beforeWrite(commitActor, plan.files);
    let appended: Event[];
    try {
      appended = await this.applySync(meta, plan, replay);
    } catch (e) {
      // 快照可能已经改了一部分：这台机器下一次应用时整体核对快照目录
      await this.markReconcile(meta.projectId, meta.machineId);
      throw e;
    } finally {
      await this.committer.track(commitActor, plan.files, plan.event ? [plan.event.type] : []);
    }
    this.snapshots.clearCorrupt(meta.projectId, plan.writes.map((f) => f.sha256));
    if (plan.reconciled) {
      await this.snapshots.clearReconcile(meta.projectId, meta.machineId).catch((e: unknown) => {
        this.log(`清除快照核对标记失败，下次同步时会再核对一次：${(e as Error).message}`);
      });
    }
    return appended;
  }

  /**
   * 在 planSync 的基础上，这台机器有整体核对标记时，再把快照目录里清单差异没覆盖到的出入
   * （多出来的文件、缺失或内容不符的文件）并进要删除和写入的列表。只读，不改任何东西。
   */
  private async preparePlan(
    meta: StagingMeta,
    committedAt: string,
    actor: Actor,
    counts: SyncCounts | null,
    eventId: string,
  ): Promise<SyncPlan> {
    const plan = this.planSync(meta, committedAt, actor, counts, eventId);
    if (!this.snapshots.needsReconcile(meta.projectId, meta.machineId)) return plan;
    const extra = await this.snapshots.reconcileDiff(meta.projectId, meta.machineId, plan.manifest);
    const writePaths = new Set(plan.writes.map((f) => f.path));
    const writes = [...plan.writes, ...extra.writes.filter((f) => !writePaths.has(f.path))];
    // 核对找出的杂散项排在前面：它们可能正挡在清单差异要删除或写入的路径上
    const removed = [...new Set([...extra.removed, ...plan.removed])];
    this.snapshots.assertInside(meta.projectId, meta.machineId, removed);
    const snapshotDir = snapshotRelDir(meta.projectId, meta.machineId);
    const files = [...new Set([...plan.files, ...writes.map((f) => `${snapshotDir}/${f.path}`), ...removed.map((p) => `${snapshotDir}/${p}`)])];
    return { ...plan, writes, removed, files, reconciled: true };
  }

  /**
   * 应用所需的内容坏了或不见了：删掉坏的那份，把 hash 放回 missing，暂存回到 open，kh 补传后可以再 commit。
   * 快照可能已经改了一部分，所以同时打上整体核对标记，无论之后应用的是这份暂存还是新的同步，都会收敛到清单。
   */
  private async reopenStaging(meta: StagingMeta, shas: readonly string[]): Promise<void> {
    for (const sha of shas) await this.snapshots.removeBlob(meta.syncId, sha);
    await this.markReconcile(meta.projectId, meta.machineId);
    await this.snapshots.saveStaging({
      ...meta,
      state: "open",
      applying: null,
      missing: [...new Set([...meta.missing, ...shas])].sort(),
    });
  }

  private async markReconcile(projectId: string, machineId: string): Promise<void> {
    try {
      await this.snapshots.markReconcile(projectId, machineId);
    } catch (e) {
      this.log(`记录快照核对标记失败：${(e as Error).message}`);
    }
  }

  /**
   * 收尾：标记 applied、发通知、删除暂存目录。这时同步已经生效，收尾出错只记日志，
   * 不让调用方以为同步失败；留下的暂存下次按 applied 删除，或者按 applying 重放（结果不变）。
   */
  private async finishStaging(meta: StagingMeta, notify: () => void): Promise<void> {
    try {
      await this.snapshots.saveStaging({ ...meta, state: "applied" });
    } catch (e) {
      this.log(`同步暂存 ${meta.syncId} 标记完成失败：${(e as Error).message}`);
    }
    notify();
    await this.dropStaging(meta.syncId);
  }

  private async dropStaging(syncId: string): Promise<void> {
    try {
      await this.snapshots.removeStaging(syncId);
    } catch (e) {
      // 从内存里移除，运行期间不再拿它重放；留在磁盘上的，下次启动时按状态处理
      this.snapshots.forgetStaging(syncId);
      this.log(`删除同步暂存 ${syncId} 失败，下次启动时再清理：${(e as Error).message}`);
    }
  }

  /**
   * 启动时处理上次留下的暂存：applied 的直接删除；applying 的按顺序重新应用；
   * 过期的 open 删除，没过期的保留，kh 还可以继续上传和提交。
   */
  private async recoverStagings(nowMs: number): Promise<void> {
    for (const meta of await this.snapshots.loadStagings()) {
      if (meta.state === "applied") await this.dropStaging(meta.syncId);
    }
    await this.replayApplying(null, null, nowMs);
    await this.snapshots.removeExpired(nowMs);
  }

  /**
   * 按 committedAt 先后重新应用 applying 的暂存（projectId、machineId 为 null 时处理全部）。
   * 同一项目同一机器的某份暂存中途失败时，它之后的暂存都不再应用，保持先后顺序。
   * 从 committedAt 起超过 SYNC_STAGING_TTL_MS 仍没应用完的，丢弃并打上整体核对标记，不再挡住之后的同步。
   * 全部处理完返回 true。
   */
  private async replayApplying(projectId: string | null, machineId: string | null, nowMs: number): Promise<boolean> {
    const blocked = new Set<string>();
    for (const meta of this.snapshots.listApplying()) {
      if (projectId !== null && meta.projectId !== projectId) continue;
      if (machineId !== null && meta.machineId !== machineId) continue;
      const key = `${meta.projectId}/${meta.machineId}`;
      if (blocked.has(key)) continue;
      if (nowMs - Date.parse(meta.applying!.committedAt) > SYNC_STAGING_TTL_MS) {
        this.log(`同步暂存 ${meta.syncId} 超过有效期仍没应用完，已丢弃`);
        if (this.projects.has(meta.projectId)) await this.markReconcile(meta.projectId, meta.machineId);
        await this.dropStaging(meta.syncId);
        continue;
      }
      if (!(await this.replayStaging(meta))) blocked.add(key);
    }
    return blocked.size === 0;
  }

  /**
   * 重新应用一份 applying 的暂存。每一步都按目标状态重做，所以重做任意多次结果与一次相同。
   * 项目不在了、路径不合法、这台机器已有更新的清单时丢弃这份暂存；所需内容缺失或与 hash 不符时
   * 回到 open 等 kh 补传；开始改快照之后因为别的原因失败则保留，下次启动或这台机器下次 commit 时再试。
   * 返回是否处理完（应用、丢弃或回到 open）。
   */
  private async replayStaging(meta: StagingMeta): Promise<boolean> {
    const applying = meta.applying!;
    let plan: SyncPlan;
    try {
      if (!this.projects.has(meta.projectId)) throw new Error("项目不存在");
      // 正常情况下运行期间会先重放再应用新的同步，不会出现清单比 applying 暂存还新；出现了说明收尾出过错，
      // 这时再应用会把快照回滚到旧内容
      const current = this.snapshots.getManifest(meta.projectId, meta.machineId);
      if (current && Date.parse(current.updatedAt) > Date.parse(applying.committedAt)) throw new Error("这台机器已有更新的清单");
      plan = await this.preparePlan(meta, applying.committedAt, applying.actor, applying.counts, applying.eventId);
      const missing = await this.snapshots.collectContent(meta, plan.writes.map((f) => f.sha256));
      if (missing.length > 0) {
        this.log(`同步暂存 ${meta.syncId} 缺少 ${missing.length} 份文件内容，回到等待上传的状态`);
        await this.reopenStaging(meta, missing);
        return true;
      }
    } catch (e) {
      this.log(`丢弃无法应用的同步暂存 ${meta.syncId}：${(e as Error).message}`);
      if (this.projects.has(meta.projectId)) await this.markReconcile(meta.projectId, meta.machineId);
      await this.dropStaging(meta.syncId);
      return true;
    }
    try {
      const appended = await this.runApply(meta, plan, true);
      await this.finishStaging(meta, () => this.emit({ projectId: meta.projectId, events: appended }));
      return true;
    } catch (e) {
      if (e instanceof BlobMismatchError) {
        this.log(`同步暂存 ${meta.syncId} 的内容与 hash 不符，回到等待上传的状态`);
        await this.reopenStaging(meta, [e.sha]);
        return true;
      }
      this.log(`重新应用同步暂存 ${meta.syncId} 中途失败，保留暂存稍后再试：${(e as Error).message}`);
      return false;
    }
  }

  /** 由程序管理的文件：内容与期望不一致（包括不存在）时重写 */
  private async writeIfChanged(rel: string, content: string): Promise<void> {
    if ((await readTextOrNull(this.abs(rel))) !== content) await writeFileAtomic(this.abs(rel), content, { tmpDir: this.tmpDir });
  }

  /** 读取某个月的事件并顺带修复残行（会写文件）：只能在已经持有写入队列的任务里调用 */
  private readMonthLocked(projectId: string, month: string): Promise<Event[]> {
    return this.eventLog.readMonth(projectId, month);
  }

  /**
   * 项目全部月份的事件，按月份从早到晚、文件内按追加顺序：只能在已经持有写入队列的任务里调用。
   * 逐条追加而不是 push(...month)：单月事件条数不受限，展开成参数会栈溢出
   */
  private async readProjectEventsLocked(projectId: string): Promise<Event[]> {
    const events: Event[] = [];
    for (const month of await this.eventLog.listMonths(projectId)) {
      for (const event of await this.readMonthLocked(projectId, month)) events.push(event);
    }
    return events;
  }

  private remember(event: Event): void {
    this.touchLastEvent(event);
    // 早于内存窗口的事件（例如导入的历史事件）只在文件里，查询时按月读取
    if (monthOf(event.ts) >= this.windowStart) this.recentEvents.push(event);
  }

  private touchLastEvent(event: Event): void {
    const prev = this.lastEventAt.get(event.projectId);
    if (prev === undefined || Date.parse(event.ts) > Date.parse(prev)) this.lastEventAt.set(event.projectId, event.ts);
  }

  private commitActor(actor: Actor): CommitActor {
    const user = this.auth.getUser(actor.userId);
    const machine = actor.machineId !== null ? this.auth.getMachine(actor.machineId) : undefined;
    return {
      key: `${actor.userId}|${actor.machineId ?? ""}|${actor.via}`,
      author: { name: user?.name ?? actor.userId, email: `${actor.userId}@kanban-hub.local` },
      scope: commitScope(actor.via, machine?.name ?? actor.machineId),
    };
  }

  private emit(change: StoreChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (e) {
        this.log(`变更通知出错：${(e as Error).message}`);
      }
    }
  }

  private requireProject(id: string): ProjectState {
    const state = this.projects.get(id);
    if (!state) throw new KhError("not_found", `项目 ${id} 不存在`);
    return state;
  }

  private abs(rel: string): string {
    return path.join(this.dataDir, ...rel.split("/"));
  }
}

interface SyncCounts {
  added: number;
  modified: number;
  removed: number;
  unchanged: number;
}

interface SyncPlan {
  manifest: SnapshotManifest;
  /** 要写入的快照文件（新增和修改） */
  writes: ManifestFile[];
  /** 要删除的快照路径 */
  removed: string[];
  /** 更新了位置的项目；位置已经是目标值时为 null */
  project: Project | null;
  event: Event | null;
  counts: SyncCounts;
  /** 登记提交的文件（相对数据目录） */
  files: string[];
  /** 是否并入了整体核对的结果；应用成功后据此清除核对标记 */
  reconciled: boolean;
}

function missingContentError(missing: readonly string[]): KhError {
  return new KhError("invalid", `同步还缺少 ${missing.length} 份文件内容，请重新上传`, { missingBlobs: [...missing] });
}

function docsEvent(ctx: ops.MutationContext, projectId: string, type: "docs.synced" | "docs.pulled", change: NonNullable<Event["change"]>): Event {
  return {
    id: ctx.newId(),
    ts: ctx.now,
    projectId,
    actor: ctx.actor,
    type,
    target: null,
    change,
    text: null,
    imported: false,
  };
}

/** 旧版本在目标文件旁边放的原子写临时文件：<文件名>.tmp-<pid>-<序号> */
const LEGACY_TMP_RE = /\.tmp-\d+-\d+$/;

/**
 * 删除数据目录里旧版本留下的原子写临时文件，免得被启动补提交收进历史。
 * 跳过 .git、.tmp、.staging 和各机器的快照目录（快照里的文档可以叫任何名字）。
 */
async function removeLegacyTmpFiles(dataDir: string, rel = ""): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(path.join(dataDir, rel), { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  for (const entry of entries) {
    const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if ([".git", TMP_DIR, STAGING_DIR].includes(childRel) || /^projects\/[^/]+\/snapshots$/.test(childRel)) continue;
      await removeLegacyTmpFiles(dataDir, childRel);
    } else if (entry.isFile() && LEGACY_TMP_RE.test(entry.name)) {
      await fs.rm(path.join(dataDir, childRel), { force: true });
    }
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function readTextOrNull(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

function projectPath(id: string): string {
  return `projects/${id}/project.yaml`;
}

function boardPath(id: string): string {
  return `projects/${id}/board.yaml`;
}

/** 事件的排序：先比时间，时间相同再比 id */
function compareEvents(a: EventCursor, b: EventCursor): number {
  const diff = Date.parse(a.ts) - Date.parse(b.ts);
  if (diff !== 0) return diff;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function newestFirst(a: Event, b: Event): number {
  return compareEvents(b, a);
}

/**
 * 同一时刻多条事件的次级顺序：*.created → *.updated → task.status_changed →
 * task.human_changed → 其他。数值越大越新，与 lib/events.ts 的 secondaryOrder 是同一条
 * 规则（那边用于时间线的显示排序），latestEventPerProject 单独维护一份，避免这个纯存储层
 * 反过来依赖网页展示层的模块。
 */
function secondaryOrderForLatest(type: EventType): number {
  if (type.endsWith(".created")) return 4;
  if (type.endsWith(".updated")) return 3;
  if (type === "task.status_changed") return 2;
  if (type === "task.human_changed") return 1;
  return 0;
}

/** a 是否比 b 更“新”：先比时间，同一时刻按 secondaryOrderForLatest，再按 id 兜底 */
function isLaterEvent(a: Event, b: Event): boolean {
  const byTs = Date.parse(a.ts) - Date.parse(b.ts);
  if (byTs !== 0) return byTs > 0;
  const byOrder = secondaryOrderForLatest(a.type) - secondaryOrderForLatest(b.type);
  if (byOrder !== 0) return byOrder > 0;
  return a.id > b.id;
}

/** actor 筛选：filter 为 "web" 匹配网页操作，其余按机器 ID 匹配 */
function matchesActor(actor: Actor, filter: string): boolean {
  return filter === "web" ? actor.via === "web" : actor.machineId === filter;
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise.catch(() => fallback), timeout]).finally(() => clearTimeout(timer));
}
