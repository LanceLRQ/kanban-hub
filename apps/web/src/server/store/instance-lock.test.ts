import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isKhError } from "@kanban-hub/core/errors";
import { acquireInstanceLock, INSTANCE_LOCK_FILE } from "./instance-lock";

let dir: string;
/** afterEach 里统一释放的锁（顺序获取的场景正常释放；冲突场景本就没拿到，release 幂等） */
const locks: Awaited<ReturnType<typeof acquireInstanceLock>>[] = [];
/** afterEach 里统一杀掉的子进程（模拟别人的存活进程） */
const children: ReturnType<typeof spawn>[] = [];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "kh-lock-"));
});

afterEach(async () => {
  for (const lock of locks) await lock.release().catch(() => {});
  for (const child of children) child.kill();
  await fs.rm(dir, { recursive: true, force: true });
});

function lockFile(): string {
  return path.join(dir, INSTANCE_LOCK_FILE);
}

/** 拿锁并登记到 afterEach 释放清单 */
async function acquire() {
  const lock = await acquireInstanceLock(dir);
  locks.push(lock);
  return lock;
}

/** 起一个长驻子进程，模拟另一个持有锁的存活进程；afterEach 统一杀掉 */
function livingProcess(): number {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"]);
  children.push(child);
  return child.pid!;
}

/** 起一个立刻退出的子进程，拿一个确定已死的 pid（模拟崩溃残留的锁） */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""]);
  await once(child, "exit");
  return child.pid!;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error("预期抛出错误");
}

describe("单实例锁", () => {
  it("首次获取：锁文件写入当前进程的 pid 与获取时间", async () => {
    const before = Date.now();
    const lock = await acquire();
    expect(lock.pid).toBe(process.pid);
    const [pidLine, atLine] = (await fs.readFile(lockFile(), "utf8")).split("\n");
    expect(pidLine).toBe(String(process.pid));
    // 获取时间写的是 ISO 时间，取整秒的容差足够；解析不出来会在这里直接失败
    expect(Math.abs(Date.parse(atLine!) - before)).toBeLessThan(5000);
  });

  it("正常释放删掉锁文件，之后可以再次获取", async () => {
    const lock = await acquire();
    await lock.release();
    await expect(fs.access(lockFile())).rejects.toMatchObject({ code: "ENOENT" });
    await acquire();
  });

  it("重复释放是空操作，不抛错", async () => {
    const lock = await acquire();
    await lock.release();
    await lock.release();
  });

  it("锁被存活进程持有时拒绝：抛 conflict，消息带上对方的 pid", async () => {
    const pid = livingProcess();
    await fs.writeFile(lockFile(), `${pid}\n2026-09-30T00:00:00.000Z\n`);
    const err = await rejection(acquireInstanceLock(dir));
    expect(isKhError(err)).toBe(true);
    expect(err).toMatchObject({ code: "conflict" });
    expect((err as Error).message).toContain(`PID ${pid}`);
  });

  it("锁属于已死进程时覆盖接管：换上自己的 pid", async () => {
    await fs.writeFile(lockFile(), `${await deadPid()}\n2026-09-30T00:00:00.000Z\n`);
    const lock = await acquire();
    expect(lock.pid).toBe(process.pid);
    expect(await fs.readFile(lockFile(), "utf8")).toContain(String(process.pid));
  });

  it("锁文件内容损坏（非数字）当作可接管", async () => {
    await fs.writeFile(lockFile(), "不是数字\n");
    const lock = await acquire();
    expect(lock.pid).toBe(process.pid);
  });

  it("释放只删自己的锁：锁已被别的进程接管时不动它", async () => {
    const lock = await acquire();
    // 模拟锁被接管：内容换成一个确定已死的 pid（本用例里它只是“别人的 pid”）
    const other = `${await deadPid()}\n2026-09-30T00:00:00.000Z\n`;
    await fs.writeFile(lockFile(), other);
    await lock.release();
    expect(await fs.readFile(lockFile(), "utf8")).toBe(other);
  });
});
