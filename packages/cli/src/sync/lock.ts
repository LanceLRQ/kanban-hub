import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveKhHome } from "../config/home";
import type { CliContext } from "../context";
import { CliError, EXIT } from "../errors";
import { isNoEntError } from "../fs-utils";

/** 超过这个时长没有刷新的锁视为陈旧（持有者多半已经卡死或崩溃而没能清理锁文件），可以被接管 */
const LOCK_STALE_MS = 10 * 60 * 1000;

/** 持有锁期间每隔这么久刷新一次锁内容里的 refreshedAt，证明持有者还在工作 */
const LOCK_REFRESH_MS = 60 * 1000;

/** 锁被占用时，withSyncLock 默认最多等待这么久后才放弃并报错 */
const LOCK_WAIT_MS = 5 * 1000;

/** 等待期间每隔这么久重新尝试一次获取锁 */
const LOCK_WAIT_RETRY_MS = 200;

/**
 * 用 Symbol.for 品牌标记，而不是 `instanceof SyncLockBusyError`：Turbopack 会把同一份
 * 源码编译成多个模块实例，跨实例 instanceof 会误判为 false。品牌挂在
 * 全局 symbol 注册表上，任何模块实例创建的错误对象都能被任何模块实例识别出来。
 */
const SYNC_LOCK_BUSY_BRAND = Symbol.for("kanban-hub.sync-lock-busy");

/** 同步锁被占用（且未陈旧）时抛出的错误：退出码沿用原来的 1，文字也不变 */
export class SyncLockBusyError extends CliError {
  readonly [SYNC_LOCK_BUSY_BRAND] = true;

  constructor() {
    super(EXIT.UNEXPECTED, "另一个同步或拉取正在进行", "等待它结束后重试");
    this.name = "SyncLockBusyError";
  }
}

/** 判断某个错误是不是“同步锁被占用” —— 用品牌而不是 instanceof，见 SyncLockBusyError 的说明 */
export function isSyncLockBusyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as Record<PropertyKey, unknown>)[SYNC_LOCK_BUSY_BRAND] === true;
}

const lockContentSchema = z.object({
  pid: z.number().int().positive(),
  startedAt: z.string(),
  /** 最近一次刷新的时间；刚获取、还没刷新过时没有这个字段，按 startedAt 算 */
  refreshedAt: z.string().optional(),
  /** 每次获取时随机生成，用来确认锁仍是自己的；旧版本 kh 写的锁没有这个字段 */
  token: z.string().optional(),
});

type LockContent = z.infer<typeof lockContentSchema>;

function lockPath(home: string, projectId: string): string {
  return path.join(home, "cache", projectId, "lock");
}

/** 用信号 0 探测进程是否还活着，不会真的杀掉它 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM：进程存在，只是没有权限给它发信号，也当作活着；只有明确查不到进程（ESRCH）才算退出
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 内容无法解析时返回 null；文件不存在时也返回 null（调用方按各自需要区分这两种情况） */
async function readLock(file: string): Promise<LockContent | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if (isNoEntError(err)) return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = lockContentSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

async function mtimeOf(file: string): Promise<number | null> {
  try {
    return (await fs.stat(file)).mtimeMs;
  } catch (err) {
    if (isNoEntError(err)) return null;
    throw err;
  }
}

/**
 * 判定锁文件是否陈旧。内容能解析出来时，按“持有者进程已退出”或“超过 10 分钟没有刷新”判断
 * （持有者每分钟刷新一次 refreshedAt，所以活着且还在工作的持有者不会因为持有得久被接管）。内容解析不出来——既可能是持有者写坏了，也可能正好撞上另一个进程刚创建文件、还没来得
 * 及写完内容的窗口期（"wx" 独占创建之后，写入数据之前文件会短暂存在但为空）——这种情况不能
 * 直接当陈旧处理，否则会把刚创建锁的合法持有者判成陈旧并抢走它的锁；改用文件自身的 mtime
 * 判断：mtime 距今超过 10 分钟才算陈旧，否则当作“有人持有，只是内容还没读到”。
 */
async function isStale(file: string, ctx: CliContext): Promise<boolean> {
  const lock = await readLock(file);
  if (lock !== null) {
    if (!isProcessAlive(lock.pid)) return true;
    const age = ctx.now().getTime() - new Date(lock.refreshedAt ?? lock.startedAt).getTime();
    return age >= LOCK_STALE_MS;
  }
  const mtimeMs = await mtimeOf(file);
  if (mtimeMs === null) return true; // 文件已经不在了，没什么可接管的，放心让调用方重新创建
  const age = ctx.now().getTime() - mtimeMs;
  return age >= LOCK_STALE_MS;
}

/** 获取成功时返回写进锁文件的内容，之后刷新、释放都用其中的 token 确认锁仍是自己的 */
async function acquireLock(file: string, ctx: CliContext): Promise<LockContent> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const mine: LockContent = { pid: process.pid, startedAt: ctx.now().toISOString(), token: randomBytes(16).toString("hex") };
  const content = JSON.stringify(mine);

  for (;;) {
    try {
      // 一次 writeFile 调用（而不是先 open 再单独 writeFile）收窄“文件已创建但内容还没写完”
      // 的空窗期；即便如此这个窗口不可能完全消除，isStale 已经按上面的说明处理了这种情况
      await fs.writeFile(file, content, { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (!(await isStale(file, ctx))) {
        throw new SyncLockBusyError();
      }
      // 陈旧锁：删除后回到循环顶部重新抢锁。两个进程可能同时判定陈旧并都尝试删除，
      // 这里的删除失败（文件已经被对方删掉）忽略即可，下一轮 "wx" 会决出胜负
      await fs.rm(file, { force: true });
      continue;
    }

    // 刚写完不代表锁真的是自己的：可能在“判定陈旧、删除、重建”的过程中，另一个进程抢先
    // 完成了同样的流程并写入了它自己的内容，把这次的 writeFile 覆盖掉了（wx 只保证创建时
    // 独占，不保证内容不被后来者用同样的手段整体替换）。重新读一次，确认内容确实是自己刚才
    // 写的那一份，不是就当作没抢到，按“另一个同步或拉取正在进行”报错，不能把不属于自己的
    // 锁当成拿到手了。
    if (!(await isMine(file, mine))) {
      throw new SyncLockBusyError();
    }
    return mine;
  }
}

/** 获取锁被占用时先等一等再重试；等到 deadline 还没抢到就把最后一次的 SyncLockBusyError 抛出去 */
async function acquireLockWithWait(file: string, ctx: CliContext, waitMs: number, retryIntervalMs: number): Promise<LockContent> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return await acquireLock(file, ctx);
    } catch (err) {
      if (!isSyncLockBusyError(err) || Date.now() >= deadline) throw err;
      const remaining = deadline - Date.now();
      await sleep(Math.min(retryIntervalMs, Math.max(remaining, 0)));
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 回读锁文件，确认内容仍是自己写的那一份（pid 与 token 都对得上） */
async function isMine(file: string, mine: LockContent): Promise<boolean> {
  const current = await readLock(file);
  return current !== null && current.pid === mine.pid && current.token === mine.token;
}

/**
 * 探测同步锁是否被占用：锁文件存在，且按获取锁时同一套规则判断不是陈旧的，才算被占用。
 * SessionStart 的自动拉取用它来决定要不要跳过（被占用就不等，直接跳过），不像 withSyncLock
 * 那样真的去抢锁、也不会创建或修改锁文件。
 */
export async function isSyncLockBusy(ctx: CliContext, projectId: string): Promise<boolean> {
  const home = resolveKhHome(ctx);
  const file = lockPath(home, projectId);
  const mtimeMs = await mtimeOf(file);
  if (mtimeMs === null) return false;
  return !(await isStale(file, ctx));
}

/**
 * 刷新锁：先确认锁仍是自己的，再把带新 refreshedAt 的内容写到临时文件、rename 覆盖锁文件，
 * 读的一方不会读到写了一半的内容。锁已经不是自己的（被接管）就不动它。
 */
async function refreshLock(file: string, mine: LockContent, ctx: CliContext): Promise<void> {
  if (!(await isMine(file, mine))) return;
  const tmp = `${file}.${mine.token}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ ...mine, refreshedAt: ctx.now().toISOString() }));
  await fs.rename(tmp, file);
}

/**
 * kh sync / kh pull / kh conflicts resolve 用的进程间互斥锁：同一时刻只允许一个持有者。
 * 持有期间每分钟刷新一次锁内容里的 refreshedAt；持有者进程已经不在，或者超过 10 分钟没有
 * 刷新，都视为陈旧锁，允许接管；否则先等待（每 waitMs 里的一段 retryIntervalMs 重试一次），
 * 等到期限还是抢不到才报错退出。fn 无论成功还是抛出异常，都会停止刷新并释放锁；
 * 释放前回读，锁已经被别人接管时不删除。refreshIntervalMs、waitMs、retryIntervalMs
 * 只给测试缩短等待时长用。
 */
export async function withSyncLock<T>(
  ctx: CliContext,
  projectId: string,
  fn: () => Promise<T>,
  opts: { refreshIntervalMs?: number; waitMs?: number; retryIntervalMs?: number } = {},
): Promise<T> {
  const home = resolveKhHome(ctx);
  const file = lockPath(home, projectId);
  const mine = await acquireLockWithWait(file, ctx, opts.waitMs ?? LOCK_WAIT_MS, opts.retryIntervalMs ?? LOCK_WAIT_RETRY_MS);

  // 刷新失败（例如磁盘暂时写不进去）不打断正在进行的同步，下一次定时再试
  let inflight: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    inflight = inflight.then(() => refreshLock(file, mine, ctx)).catch(() => {});
  }, opts.refreshIntervalMs ?? LOCK_REFRESH_MS);
  timer.unref();

  try {
    return await fn();
  } finally {
    clearInterval(timer);
    // 等进行中的刷新结束，免得它在删除之后又把锁文件写回来
    await inflight;
    await fs.rm(`${file}.${mine.token}.tmp`, { force: true });
    if (await isMine(file, mine)) await fs.rm(file, { force: true });
  }
}
