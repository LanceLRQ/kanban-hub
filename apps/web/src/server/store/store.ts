import fs from "node:fs/promises";
import path from "node:path";
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
  type Event,
  type LogInput,
  type Project,
  type ProjectCreateInput,
  type ProjectPatchInput,
  type Task,
  type TaskCreateInput,
  type TaskPatchInput,
  actorSchema,
  boardSchema,
  eventSchema,
  projectSchema,
} from "@kanban-hub/core/schema";
import { AUTH_DIR, AuthRepo } from "./auth";
import { type CommitActor, Committer } from "./committer";
import { EventLog, monthOf, recentMonths } from "./events";
import { DataFileError, readYamlFile, writeFileAtomic, writeYamlFile } from "./fsio";
import { GitRepo } from "./git";
import { WriteQueue } from "./queue";

/** 数据目录的 .gitignore：凭据、同步暂存、原子写的临时文件都不进 git 历史 */
export const DATA_GITIGNORE = ["# kanban-hub 数据目录", "/auth/", "/.staging/", "*.tmp-*", ""].join("\n");
/** 启动时读进内存的事件月份数（规格 6.2） */
export const RECENT_EVENT_MONTHS = 3;
/** 关闭时等待写入队列和提交的上限 */
export const CLOSE_TIMEOUT_MS = 5_000;

export interface StoreOptions {
  dataDir: string;
  now?: () => Date;
  newId?: () => string;
  commitDebounceMs?: number;
  gitBin?: string;
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
}

export interface MutationOptions {
  /** 网页请求带上的版本号，与当前版本不一致时报 conflict */
  expectedVersion?: number;
}

interface Outcome<T> {
  projectId: string;
  project?: Project;
  board?: Board;
  events: Event[];
  value: T;
}

export class Store {
  readonly auth: AuthRepo;
  private readonly queue = new WriteQueue();
  private readonly git: GitRepo;
  private readonly committer: Committer;
  private readonly eventLog: EventLog;
  private readonly projects = new Map<string, ProjectState>();
  /** 内存里的事件：windowStart 及以后月份的全部事件（规格 6.2） */
  private readonly recentEvents: Event[] = [];
  private windowStart = "";
  private readonly lastEventAt = new Map<string, string>();
  private readonly listeners = new Set<(change: StoreChange) => void>();
  private closing = false;
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
    this.git = new GitRepo(dataDir, opts.gitBin);
    this.eventLog = new EventLog(dataDir);
    this.auth = new AuthRepo(dataDir, this.queue, { now: this.now, newId: this.newId });
    this.committer = new Committer({
      git: this.git,
      runExclusive: (job) => this.queue.run(job),
      debounceMs: opts.commitDebounceMs,
      log: this.log,
    });
  }

  /** 打开数据目录。数据文件有问题时抛出 DataFileError（带文件和行号） */
  static async open(opts: StoreOptions): Promise<Store> {
    const store = new Store(opts.dataDir, opts);
    await store.load();
    return store;
  }

  // ---------- 查询（读内存，同步） ----------

  listProjects(): Project[] {
    return [...this.projects.values()].map((s) => s.project);
  }

  getProject(id: string): Project | undefined {
    return this.projects.get(id)?.project;
  }

  getBoard(projectId: string): Board | undefined {
    return this.projects.get(projectId)?.board;
  }

  findProjectsByFingerprint(fingerprint: string): Project[] {
    return this.listProjects().filter((p) => p.fingerprint === fingerprint);
  }

  /** 项目最后一条事件的时间，停滞判定用 */
  getLastEventAt(projectId: string): string | null {
    return this.lastEventAt.get(projectId) ?? null;
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
  async listEvents(query: EventQuery): Promise<Event[]> {
    // 项目不存在时拒绝，且必须在内存过滤和读文件之前：query.projectId 不检查就拼进文件路径，
    // 会把不存在的（或路径穿越的）ID 拼出数据目录外的路径去读（M2 把 not_found 映射成 404）
    if (query.projectId !== undefined && !this.projects.has(query.projectId)) {
      throw new KhError("not_found", "项目不存在");
    }
    const matches = (e: Event) =>
      (query.projectId === undefined || e.projectId === query.projectId) &&
      (query.before === undefined || compareEvents(e, query.before) < 0);
    const result = this.recentEvents.filter(matches).sort(newestFirst).slice(0, query.limit);
    if (result.length >= query.limit) return result;
    // 读旧文件时可能顺带修复残行，放进写入队列，避免和追加事件交错
    return this.queue.run(async () => {
      const projectIds = query.projectId !== undefined ? [query.projectId] : [...this.projects.keys()];
      const byMonth = new Map<string, string[]>();
      for (const id of projectIds) {
        for (const month of await this.eventLog.listMonths(id)) {
          if (month < this.windowStart) byMonth.set(month, [...(byMonth.get(month) ?? []), id]);
        }
      }
      for (const month of [...byMonth.keys()].sort().reverse()) {
        const batch: Event[] = [];
        for (const id of byMonth.get(month)!) batch.push(...(await this.eventLog.readMonth(id, month)).filter(matches));
        result.push(...batch.sort(newestFirst));
        if (result.length >= query.limit) break;
      }
      return result.slice(0, query.limit);
    });
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

  /** 关机：停止接收写入，等写入队列跑完，再提交全部待提交的改动。超时返回 false */
  async close(timeoutMs = CLOSE_TIMEOUT_MS): Promise<boolean> {
    this.closing = true;
    const done = await withTimeout(
      this.queue.run(() => this.committer.flushNow()),
      timeoutMs,
      false,
    );
    this.committer.close();
    return done;
  }

  // ---------- 内部 ----------

  private async load(): Promise<void> {
    const created = await this.git.init();
    // 进程在 git 提交途中被强杀会留下锁文件；数据目录只有本服务在写，启动时不会有别的 git 进程在运行
    await fs.rm(this.abs(".git/index.lock"), { force: true });
    if (!(await pathExists(this.abs(".gitignore")))) await writeFileAtomic(this.abs(".gitignore"), DATA_GITIGNORE);
    await this.auth.load();
    this.windowStart = recentMonths(this.now(), RECENT_EVENT_MONTHS)[0]!;
    for (const id of await this.listProjectDirs()) await this.loadProject(id);
    // 规格 6.5：上次退出前没来得及提交的改动（包括加载时修复的事件文件残行）补一次提交。
    // 提交失败不影响数据，也不阻止启动（规格第 15 节）；改动留在工作区，下次启动时再补
    try {
      // auth/ 显式排除，不依赖 .gitignore：它一旦被改动或丢失（例如从备份还原），
      // 凭据文件就会靠这一层兜底而不是进 git 历史
      await this.git.commitAll(created ? "初始化数据目录" : "补提交上次未提交的改动", [AUTH_DIR]);
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
      if (out.board) await writeYamlFile(this.abs(boardPath(out.projectId)), out.board);
      if (out.project) await writeYamlFile(this.abs(projectPath(out.projectId)), out.project);
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
      this.emit({ projectId: out.projectId, events: appended });
      return out.value;
    });
  }

  private remember(event: Event): void {
    this.touchLastEvent(event);
    // 早于内存窗口的事件（例如 M6 导入的历史事件）只在文件里，查询时按月读取
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

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise.catch(() => fallback), timeout]).finally(() => clearTimeout(timer));
}
