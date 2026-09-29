import fs from "node:fs/promises";
import path from "node:path";
import { KhError } from "@kanban-hub/core/errors";

/** 数据目录里的单实例锁文件（相对数据目录根），同时也在程序管理的 .gitignore 清单里 */
export const INSTANCE_LOCK_FILE = ".instance.lock";

/** 单实例锁：持有期间数据目录只归当前进程使用，正常关闭时 release 删掉锁文件 */
export interface InstanceLock {
  /** 拿到锁的进程（就是当前进程） */
  readonly pid: number;
  /**
   * 删除锁文件。重复调用是空操作；锁已被别的进程接管（内容里的 pid 不是自己）时不删对方的锁。
   * 释放失败会抛出，由调用方决定怎么记日志——崩溃残留的锁会在下次启动时按死进程接管消化。
   */
  release(): Promise<void>;
}

/** 锁文件内容：pid 一行、获取时间一行。时间只供人排查，互斥判断只看 pid */
function lockContent(pid: number, at: Date): string {
  return `${pid}\n${at.toISOString()}\n`;
}

/** 从锁文件内容解析 pid；内容损坏（空、非正整数）返回 null，按可接管处理 */
function parseLockPid(content: string): number | null {
  const pid = Number(content.split("\n", 1)[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** 进程是否还活着。发不出信号的其他错误（EPERM：是别人的进程）同样按存活处理 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

class FileInstanceLock implements InstanceLock {
  readonly pid: number;
  private released = false;

  constructor(private readonly file: string, pid: number) {
    this.pid = pid;
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    // 读不到或内容已不是自己的 pid，说明锁被接管或已不在，不能去删别人持有的锁
    const content = await fs.readFile(this.file, "utf8").catch(() => "");
    if (parseLockPid(content) === this.pid) await fs.rm(this.file, { force: true });
  }
}

/**
 * 数据目录的单实例锁：同一目录不允许两个进程同时打开（互相覆盖数据）。
 * 用 "wx" 独占创建锁文件；已存在时按内容里的 pid 探测原持有者——进程已死（崩溃残留）
 * 就覆盖接管，还活着就抛 conflict（boot 会把它打印成启动失败并退出）。
 * 两个进程同时接管同一把死锁的竞态不设防：个人自托管下两个实例同时启动又恰好赶上
 * 同一个残留锁的概率可以忽略，真发生时两侧的启动补提交仍按 git 先后落盘，不会丢数据。
 */
export async function acquireInstanceLock(dataDir: string): Promise<InstanceLock> {
  const file = path.join(dataDir, INSTANCE_LOCK_FILE);
  try {
    await fs.writeFile(file, lockContent(process.pid, new Date()), { flag: "wx" });
    return new FileInstanceLock(file, process.pid);
  } catch (e) {
    // 其余错误（权限、目录不存在）是环境问题，原样抛出让启动失败
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const holder = parseLockPid(await fs.readFile(file, "utf8"));
  if (holder !== null && processAlive(holder)) {
    throw new KhError(
      "conflict",
      `数据目录已被 PID ${holder} 的进程占用。若确认该进程已不在运行，删除 ${file} 后重试`,
      { pid: holder },
    );
  }
  // 原持有者已死（或内容损坏）：覆盖接管。此刻起数据目录归当前进程
  await fs.writeFile(file, lockContent(process.pid, new Date()), { flag: "w" });
  return new FileInstanceLock(file, process.pid);
}
