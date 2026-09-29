import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnDetachedNode } from "./spawn";

const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) await fs.rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(prefix = "kh-spawn-"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** 轮询直到 check 返回 true，最多等 timeoutMs */
async function waitFor(check: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error("等待超时");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("spawnDetachedNode", () => {
  it("启动一个先睡 1 秒再输出的脚本：函数立即返回，输出最终进了日志文件", async () => {
    const dir = await tempDir();
    const script = path.join(dir, "script.mjs");
    await fs.writeFile(
      script,
      "await new Promise((r) => setTimeout(r, 1000)); process.stdout.write('done:' + process.env.KH_TEST_VAR + '\\n');",
    );
    const logFile = path.join(dir, "logs", "hook.log");

    const startedAt = Date.now();
    spawnDetachedNode(script, [], { cwd: dir, env: { ...process.env, KH_TEST_VAR: "abc" }, logFile });
    expect(Date.now() - startedAt).toBeLessThan(500);

    await waitFor(async () => (await fs.readFile(logFile, "utf8")).includes("done:abc"));
  });

  it("日志目录不存在时自动创建", async () => {
    const dir = await tempDir();
    const script = path.join(dir, "script.mjs");
    await fs.writeFile(script, "process.stdout.write('ok\\n');");
    const logFile = path.join(dir, "nested", "logs", "hook.log");

    spawnDetachedNode(script, [], { cwd: dir, env: process.env, logFile });

    await waitFor(async () => {
      try {
        return (await fs.readFile(logFile, "utf8")).includes("ok");
      } catch {
        return false;
      }
    });
  });

  it("cwd 不存在时不抛出未捕获的异常，日志里有原因", async () => {
    const dir = await tempDir();
    const script = path.join(dir, "script.mjs");
    await fs.writeFile(script, "process.stdout.write('ok\\n');");
    const logFile = path.join(dir, "logs", "hook.log");
    const missingCwd = path.join(dir, "no-such-dir");

    expect(() => spawnDetachedNode(script, [], { cwd: missingCwd, env: process.env, logFile })).not.toThrow();

    await waitFor(async () => {
      try {
        const content = await fs.readFile(logFile, "utf8");
        return content.length > 0;
      } catch {
        return false;
      }
    });
  });

  it("entry 指向不存在的文件时不抛出未捕获的异常，日志里有原因（来自子进程自身的错误输出）", async () => {
    const dir = await tempDir();
    const logFile = path.join(dir, "logs", "hook.log");
    const missingEntry = path.join(dir, "no-such-script.mjs");

    expect(() => spawnDetachedNode(missingEntry, [], { cwd: dir, env: process.env, logFile })).not.toThrow();

    await waitFor(async () => {
      try {
        const content = await fs.readFile(logFile, "utf8");
        return content.length > 0;
      } catch {
        return false;
      }
    });
  });
});
