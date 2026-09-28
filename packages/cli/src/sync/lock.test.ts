import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT } from "../errors";
import { fakeContext } from "../repo/test-helpers";
import { withSyncLock } from "./lock";

const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) await fs.rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kh-lock-"));
  dirs.push(dir);
  return dir;
}

async function lockFilePath(home: string, projectId: string): Promise<string> {
  return path.join(home, "cache", projectId, "lock");
}

describe("withSyncLock", () => {
  it("锁不存在时正常获取并执行 fn，结束后释放", async () => {
    const home = await tempDir();
    const ctx = fakeContext({ env: { KH_HOME: home } });
    const result = await withSyncLock(ctx, "p000000001", async () => "done");
    expect(result).toBe("done");

    const file = await lockFilePath(home, "p000000001");
    await expect(fs.access(file)).rejects.toThrow();
  });

  it("第二个持有者（进程仍存活、未超时）报错，退出码 1", async () => {
    const home = await tempDir();
    const ctx = fakeContext({ env: { KH_HOME: home } });
    const file = await lockFilePath(home, "p000000001");
    await fs.mkdir(path.dirname(file), { recursive: true });
    // 当前测试进程自己的 pid 一定存活；startedAt 就是 ctx.now()，不超过 10 分钟
    await fs.writeFile(file, JSON.stringify({ pid: process.pid, startedAt: ctx.now().toISOString() }));

    await expect(withSyncLock(ctx, "p000000001", async () => "x")).rejects.toMatchObject({
      name: "CliError",
      exitCode: EXIT.UNEXPECTED,
    });
  });

  it("持有者进程已退出时接管旧锁", async () => {
    const home = await tempDir();
    const ctx = fakeContext({ env: { KH_HOME: home } });
    const file = await lockFilePath(home, "p000000001");
    await fs.mkdir(path.dirname(file), { recursive: true });

    // spawnSync 同步等待子进程退出后才返回，之后它的 pid 必然已经不在了
    const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const stalePid = child.pid;
    expect(typeof stalePid).toBe("number");

    await fs.writeFile(file, JSON.stringify({ pid: stalePid, startedAt: ctx.now().toISOString() }));

    const result = await withSyncLock(ctx, "p000000001", async () => "took-over");
    expect(result).toBe("took-over");
  });

  it("锁超过 10 分钟时接管（即使持有者进程还活着）", async () => {
    const home = await tempDir();
    const start = new Date("2026-01-01T00:00:00.000Z");
    const later = new Date(start.getTime() + 11 * 60 * 1000);
    const file = await lockFilePath(home, "p000000001");
    await fs.mkdir(path.dirname(file), { recursive: true });
    // 用当前测试进程自己的 pid：一定存活，专门验证“超时”这一条件单独也能触发接管
    await fs.writeFile(file, JSON.stringify({ pid: process.pid, startedAt: start.toISOString() }));

    const ctx = fakeContext({ env: { KH_HOME: home }, now: () => later });
    const result = await withSyncLock(ctx, "p000000001", async () => "took-over");
    expect(result).toBe("took-over");
  });

  it("锁不到 10 分钟且持有者存活时不接管", async () => {
    const home = await tempDir();
    const start = new Date("2026-01-01T00:00:00.000Z");
    const soon = new Date(start.getTime() + 9 * 60 * 1000);
    const file = await lockFilePath(home, "p000000001");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ pid: process.pid, startedAt: start.toISOString() }));

    const ctx = fakeContext({ env: { KH_HOME: home }, now: () => soon });
    await expect(withSyncLock(ctx, "p000000001", async () => "x")).rejects.toMatchObject({
      exitCode: EXIT.UNEXPECTED,
    });
  });

  it("空锁文件（内容还没写完，mtime 是现在）不会被接管", async () => {
    const home = await tempDir();
    const start = new Date("2026-01-01T00:00:00.000Z");
    const file = await lockFilePath(home, "p000000001");
    await fs.mkdir(path.dirname(file), { recursive: true });
    // 模拟 "wx" 创建成功、内容还没写完的窗口：文件存在但是空的，mtime 就是创建时刻（现在）
    await fs.writeFile(file, "");

    const ctx = fakeContext({ env: { KH_HOME: home }, now: () => start });
    await expect(withSyncLock(ctx, "p000000001", async () => "x")).rejects.toMatchObject({
      name: "CliError",
      exitCode: EXIT.UNEXPECTED,
    });
  });

  it("空锁文件的 mtime 超过 10 分钟会被接管", async () => {
    const home = await tempDir();
    const start = new Date("2026-01-01T00:00:00.000Z");
    const later = new Date(start.getTime() + 11 * 60 * 1000);
    const file = await lockFilePath(home, "p000000001");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "");
    // 把这个空文件的 mtime 手动改到 11 分钟前，模拟内容损坏且已经陈旧的锁
    const oldMtime = new Date(later.getTime() - 11 * 60 * 1000);
    await fs.utimes(file, oldMtime, oldMtime);

    const ctx = fakeContext({ env: { KH_HOME: home }, now: () => later });
    const result = await withSyncLock(ctx, "p000000001", async () => "took-over");
    expect(result).toBe("took-over");
  });

  it("fn 抛错后锁被释放", async () => {
    const home = await tempDir();
    const ctx = fakeContext({ env: { KH_HOME: home } });

    await expect(
      withSyncLock(ctx, "p000000001", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // 锁已经被释放：再拿一次应该立刻成功
    const result = await withSyncLock(ctx, "p000000001", async () => "second");
    expect(result).toBe("second");
  });

  it("持有超过 10 分钟但仍在定期刷新时不被接管", async () => {
    const home = await tempDir();
    const start = new Date("2026-01-01T00:00:00.000Z").getTime();
    let nowMs = start;
    const ctx = fakeContext({ env: { KH_HOME: home }, now: () => new Date(nowMs) });
    const file = await lockFilePath(home, "p000000001");

    const result = await withSyncLock(
      ctx,
      "p000000001",
      async () => {
        // 持有到第 9 分钟时至少刷新一次
        nowMs = start + 9 * 60 * 1000;
        await waitFor(async () => (JSON.parse(await fs.readFile(file, "utf8")) as { refreshedAt?: string }).refreshedAt === new Date(nowMs).toISOString());
        // 到第 15 分钟：距开始已超过 10 分钟，但距上次刷新不到 10 分钟，另一个 kh 不能接管
        nowMs = start + 15 * 60 * 1000;
        await expect(withSyncLock(ctx, "p000000001", async () => "stolen")).rejects.toMatchObject({
          exitCode: EXIT.UNEXPECTED,
        });
        return "held";
      },
      { refreshIntervalMs: 10 },
    );
    expect(result).toBe("held");
    await expect(fs.access(file)).rejects.toThrow();
  });

  it("释放时锁已经被别人接管：不删除别人的锁", async () => {
    const home = await tempDir();
    const ctx = fakeContext({ env: { KH_HOME: home } });
    const file = await lockFilePath(home, "p000000001");
    const other = JSON.stringify({ pid: process.pid, startedAt: ctx.now().toISOString(), token: "someone-else" });

    await withSyncLock(ctx, "p000000001", async () => {
      // 模拟持有期间锁被判为陈旧、被另一个 kh 接管并写入了它自己的内容
      await fs.writeFile(file, other);
    });

    expect(await fs.readFile(file, "utf8")).toBe(other);
  });

  it("锁内容带每次获取时生成的随机 token，两次获取不同", async () => {
    const home = await tempDir();
    const ctx = fakeContext({ env: { KH_HOME: home } });
    const file = await lockFilePath(home, "p000000001");
    const tokens: string[] = [];
    for (let i = 0; i < 2; i++) {
      await withSyncLock(ctx, "p000000001", async () => {
        tokens.push((JSON.parse(await fs.readFile(file, "utf8")) as { token: string }).token);
      });
    }
    expect(tokens[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(tokens[1]).toMatch(/^[0-9a-f]{32}$/);
    expect(tokens[0]).not.toBe(tokens[1]);
  });
});

/** 轮询直到 check 返回 true，最多等 2 秒 */
async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      if (await check()) return;
    } catch {
      // 刷新过程中读到的内容可能暂时不完整，继续等
    }
    if (Date.now() > deadline) throw new Error("等待超时");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
