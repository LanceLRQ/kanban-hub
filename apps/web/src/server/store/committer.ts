import { commitMessage } from "@kanban-hub/core/commit";
import type { EventType } from "@kanban-hub/core/schema";
import type { GitAuthor } from "./git";

/** 提交归属：key 相同（用户 + 机器 + 来源）的改动合成一个提交 */
export interface CommitActor {
  key: string;
  author: GitAuthor;
  /** 提交说明里的来源，例如 cli(mac)、web */
  scope: string;
}

/** 提交器用到的 git 操作，测试里可以换成假的实现 */
export interface CommitGit {
  stageFiles(paths: readonly string[]): Promise<void>;
  hasStagedChanges(): Promise<boolean>;
  commit(message: string, author: GitAuthor): Promise<void>;
}

export interface CommitterOptions {
  git: CommitGit;
  /** 把定时触发的提交排进写入队列，保证不和写文件交错 */
  runExclusive: <T>(job: () => Promise<T>) => Promise<T>;
  debounceMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  log?: (message: string) => void;
}

/** 最后一次写入后多久提交（规格 6.4） */
export const COMMIT_DEBOUNCE_MS = 30_000;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 300_000;

interface PendingGroup {
  actor: CommitActor;
  paths: Set<string>;
  types: EventType[];
}

/**
 * 按规格 6.4 提交：最后一次写入后 debounceMs 没有新写入就提交，同一批改动按操作者分组，一组一个提交。
 * 每次写操作：写文件之前调 beforeWrite，写完调 track。beforeWrite、track、flushNow 都必须在写入队列里调用。
 */
export class Committer {
  private groups: PendingGroup[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private readonly debounceMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly log: (message: string) => void;

  constructor(private readonly opts: CommitterOptions) {
    this.debounceMs = opts.debounceMs ?? COMMIT_DEBOUNCE_MS;
    this.retryBaseMs = opts.retryBaseMs ?? RETRY_BASE_MS;
    this.retryMaxMs = opts.retryMaxMs ?? RETRY_MAX_MS;
    this.log = opts.log ?? ((m) => console.warn(`[kanban-hub] ${m}`));
  }

  /**
   * 写文件之前调用：要写的文件（例如同一个项目的事件文件）已有别的操作者的待提交改动时，
   * 先把已有的改动提交掉，保证每个提交只含一个操作者的改动。
   * 必须在写文件之前：否则先提交的那一组会把这次写入的内容一起暂存进去。
   */
  async beforeWrite(actor: CommitActor, paths: readonly string[]): Promise<void> {
    if (this.overlapsOthers(actor, paths)) await this.flushNow();
  }

  /** 写完之后登记这次写入涉及的文件（相对数据目录的 POSIX 路径）和事件类型 */
  async track(actor: CommitActor, paths: readonly string[], types: readonly EventType[]): Promise<void> {
    // beforeWrite 触发的提前提交失败时：重叠的文件留在原来那一组，随那一组以原操作者身份提交；
    // 这次写入的事件类型记在自己这一组，若这一组没有别的文件，这些类型不会出现在任何提交说明里；
    // 归属与说明可能不准，但数据文件不受影响，重试成功后全部提交（规格第 15 节）
    const own = paths.filter((p) => !this.overlapsOthers(actor, [p]));
    let group = this.groups.find((g) => g.actor.key === actor.key);
    if (!group) {
      group = { actor, paths: new Set(), types: [] };
      this.groups.push(group);
    }
    for (const p of own) group.paths.add(p);
    group.types.push(...types);
    // 处于失败退避时，重试定时器已经排上了，不改回去抖时间
    if (this.failures === 0) this.schedule(this.debounceMs);
  }

  /** 立即按组提交全部待提交的改动，全部成功返回 true；失败时保留剩下的组并安排重试。必须在写入队列里调用 */
  async flushNow(): Promise<boolean> {
    this.clearTimer();
    while (this.groups.length > 0) {
      const group = this.groups[0]!;
      try {
        await this.opts.git.stageFiles([...group.paths]);
        if (await this.opts.git.hasStagedChanges()) {
          await this.opts.git.commit(commitMessage(group.actor.scope, group.types), group.actor.author);
        }
      } catch (e) {
        this.failures += 1;
        const delay = Math.min(this.retryBaseMs * 2 ** (this.failures - 1), this.retryMaxMs);
        this.log(`git 提交失败，${Math.round(delay / 1000)} 秒后重试：${(e as Error).message}`);
        this.schedule(delay);
        return false;
      }
      this.groups.shift();
    }
    this.failures = 0;
    return true;
  }

  /** 经写入队列提交全部待提交的改动 */
  flush(): Promise<boolean> {
    return this.opts.runExclusive(() => this.flushNow());
  }

  /** 待提交的文件数，网页的服务信息里显示 */
  pendingCount(): number {
    return this.groups.reduce((n, g) => n + g.paths.size, 0);
  }

  /** 停止定时器；关机时在最后一次提交之后调用 */
  close(): void {
    this.clearTimer();
  }

  private overlapsOthers(actor: CommitActor, paths: readonly string[]): boolean {
    return this.groups.some((g) => g.actor.key !== actor.key && paths.some((p) => g.paths.has(p)));
  }

  private schedule(ms: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      // flushNow 内部已经吞掉 git 失败并安排重试；这里的 catch 只是兜底，避免万一仍有异常抛出时
      // 变成未处理的 rejection（Node 默认会让进程崩溃）
      this.flush().catch((e: unknown) => this.log(`git 提交出错：${(e as Error).message}`));
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
