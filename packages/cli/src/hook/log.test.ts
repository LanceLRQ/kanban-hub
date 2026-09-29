import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fakeContext } from "../repo/test-helpers";
import { openHookLog } from "./log";

const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) await fs.rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kh-hooklog-"));
  dirs.push(dir);
  return dir;
}

describe("openHookLog", () => {
  it("路径是 KH_HOME/logs/hook.log", () => {
    const home = "/tmp/kh-home-example";
    const ctx = fakeContext({ env: { KH_HOME: home } });
    const log = openHookLog(ctx);
    expect(log.path).toBe(path.join(home, "logs", "hook.log"));
  });

  it("写一行日志：内容里带时间、事件名、项目 ID、正文", async () => {
    const home = await tempDir();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const ctx = fakeContext({ env: { KH_HOME: home }, now: () => now });
    const log = openHookLog(ctx);
    await log.write("session-start", "已接入项目", "p000000001");

    const content = await fs.readFile(log.path, "utf8");
    expect(content).toBe("2026-01-01T00:00:00.000Z session-start p000000001 已接入项目\n");
  });

  it("没有项目 ID 时不写这一段", async () => {
    const home = await tempDir();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const ctx = fakeContext({ env: { KH_HOME: home }, now: () => now });
    const log = openHookLog(ctx);
    await log.write("session-start", "没有接入任何仓库");

    const content = await fs.readFile(log.path, "utf8");
    expect(content).toBe("2026-01-01T00:00:00.000Z session-start 没有接入任何仓库\n");
  });

  it("日志目录不存在时自动创建", async () => {
    const home = await tempDir();
    const ctx = fakeContext({ env: { KH_HOME: home } });
    const log = openHookLog(ctx);
    await log.write("stop", "x");
    expect((await fs.stat(path.dirname(log.path))).isDirectory()).toBe(true);
  });

  it("超过 1 MiB 时轮转：旧内容进 hook.log.1，hook.log 只剩新的一行", async () => {
    const home = await tempDir();
    const ctx = fakeContext({ env: { KH_HOME: home } });
    const log = openHookLog(ctx);
    await fs.mkdir(path.dirname(log.path), { recursive: true });
    await fs.writeFile(log.path, "x".repeat(1024 * 1024 + 1));

    await log.write("stop", "新的一行");

    const rotated = await fs.readFile(`${log.path}.1`, "utf8");
    expect(rotated.length).toBe(1024 * 1024 + 1);
    const current = await fs.readFile(log.path, "utf8");
    expect(current.endsWith("新的一行\n")).toBe(true);
    expect(current.includes("x".repeat(100))).toBe(false);
  });

  it("写失败不抛错：KH_HOME 是一个文件（无法在它下面创建 logs 目录）", async () => {
    const home = await tempDir();
    const asFile = path.join(home, "not-a-dir");
    await fs.writeFile(asFile, "x");
    const ctx = fakeContext({ env: { KH_HOME: asFile } });
    const log = openHookLog(ctx);
    await expect(log.write("stop", "x")).resolves.toBeUndefined();
  });
});
