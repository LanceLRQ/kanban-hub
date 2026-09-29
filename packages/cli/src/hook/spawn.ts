import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface SpawnDetachedNodeOptions {
  cwd: string;
  /** 传给子进程的环境变量 */
  env: Record<string, string | undefined>;
  /** 子进程的 stdout、stderr 都追加写到这个文件 */
  logFile: string;
}

/**
 * 用 node 启动 `entry`（一个脚本文件路径），让它脱离当前进程继续运行：
 * detached + unref，父进程不等待、不持有子进程的输出流。
 *
 * 日志目录、日志文件的打开都是同步操作，失败时照常抛给调用方（例如目录所在路径
 * 没有写权限）。spawn 本身启动之后的失败（找不到可执行文件等）是异步的 error 事件，
 * 这里替它接住并记一行日志，不让它变成未捕获异常；这一步失败只写日志，不抛出。
 */
export function spawnDetachedNode(entry: string, args: string[], opts: SpawnDetachedNodeOptions): void {
  fs.mkdirSync(path.dirname(opts.logFile), { recursive: true });
  const fd = fs.openSync(opts.logFile, "a");
  try {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: opts.cwd,
      env: opts.env as NodeJS.ProcessEnv,
      detached: true,
      stdio: ["ignore", fd, fd],
    });
    child.on("error", (err) => {
      appendLogLine(opts.logFile, `启动失败：${err instanceof Error ? err.message : String(err)}`);
    });
    child.unref();
  } finally {
    // 子进程已经拿到了这个 fd 自己的一份，父进程手里的这一份可以立刻关掉
    fs.closeSync(fd);
  }
}

function appendLogLine(logFile: string, message: string): void {
  try {
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // 忽略：日志写失败不应该产生新的异常
  }
}
