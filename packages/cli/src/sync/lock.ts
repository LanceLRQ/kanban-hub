import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveKhHome } from "../config/home";
import type { CliContext } from "../context";
import { CliError, EXIT } from "../errors";
import { isNoEntError } from "../fs-utils";

/** 超过这个时长的锁视为陈旧（持有者多半已经崩溃退出而没能清理锁文件），可以被接管 */
const LOCK_STALE_MS = 10 * 60 * 1000;

const lockContentSchema = z.object({
  pid: z.number().int().positive(),
  startedAt: z.string(),
});

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
async function readLock(file: string): Promise<z.infer<typeof lockContentSchema> | null> {
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
 * 判定锁文件是否陈旧。内容能解析出 pid/startedAt 时，按“持有者进程已退出”或“超过 10 分钟”
 * 判断。内容解析不出来——既可能是持有者写坏了，也可能正好撞上另一个进程刚创建文件、还没来得
 * 及写完内容的窗口期（"wx" 独占创建之后，写入数据之前文件会短暂存在但为空）——这种情况不能
 * 直接当陈旧处理，否则会把刚创建锁的合法持有者判成陈旧并抢走它的锁；改用文件自身的 mtime
 * 判断：mtime 距今超过 10 分钟才算陈旧，否则当作“有人持有，只是内容还没读到”。
 */
async function isStale(file: string, ctx: CliContext): Promise<boolean> {
  const lock = await readLock(file);
  if (lock !== null) {
    if (!isProcessAlive(lock.pid)) return true;
    const age = ctx.now().getTime() - new Date(lock.startedAt).getTime();
    return age >= LOCK_STALE_MS;
  }
  const mtimeMs = await mtimeOf(file);
  if (mtimeMs === null) return true; // 文件已经不在了，没什么可接管的，放心让调用方重新创建
  const age = ctx.now().getTime() - mtimeMs;
  return age >= LOCK_STALE_MS;
}

async function acquireLock(file: string, ctx: CliContext): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const startedAt = ctx.now().toISOString();
  const content = JSON.stringify({ pid: process.pid, startedAt });

  for (;;) {
    try {
      // 一次 writeFile 调用（而不是先 open 再单独 writeFile）收窄“文件已创建但内容还没写完”
      // 的空窗期；即便如此这个窗口不可能完全消除，isStale 已经按上面的说明处理了这种情况
      await fs.writeFile(file, content, { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (!(await isStale(file, ctx))) {
        throw new CliError(EXIT.UNEXPECTED, "另一个同步或拉取正在进行", "等待它结束后重试");
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
    const confirmed = await readLock(file);
    if (confirmed === null || confirmed.pid !== process.pid || confirmed.startedAt !== startedAt) {
      throw new CliError(EXIT.UNEXPECTED, "另一个同步或拉取正在进行", "等待它结束后重试");
    }
    return;
  }
}

/**
 * kh sync / kh pull / kh conflicts resolve 用的进程间互斥锁：同一时刻只允许一个持有者。
 * 持有者进程已经不在，或者持有超过 10 分钟，都视为陈旧锁，允许接管；否则报错退出。
 * fn 无论成功还是抛出异常，锁都会被释放。
 */
export async function withSyncLock<T>(ctx: CliContext, projectId: string, fn: () => Promise<T>): Promise<T> {
  const home = resolveKhHome(ctx);
  const file = lockPath(home, projectId);
  await acquireLock(file, ctx);
  try {
    return await fn();
  } finally {
    await fs.rm(file, { force: true });
  }
}
