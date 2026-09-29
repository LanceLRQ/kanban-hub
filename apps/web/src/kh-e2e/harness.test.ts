/**
 * harness 本身的行为验证：默认 homeDir、spawnBackground 记录、now 注入。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupDefaultHomeDirs, makeKhContext, makeTempKhHome } from "./harness";

describe("makeKhContext", () => {
  it("不传 homeDir 时，ctx.homeDir 在临时目录下，不是真实主目录，且目录真实存在", async () => {
    const khHome = await makeTempKhHome();
    try {
      const { ctx } = makeKhContext({ cwd: khHome.dir, khHome: khHome.dir });
      expect(ctx.homeDir).not.toBe(os.homedir());
      expect(path.isAbsolute(ctx.homeDir)).toBe(true);
      expect((await fs.stat(ctx.homeDir)).isDirectory()).toBe(true);
    } finally {
      await khHome.cleanup();
    }
  });

  it("不传 spawnBackground 时，默认实现只记录调用参数", async () => {
    const khHome = await makeTempKhHome();
    try {
      const { ctx, spawnCalls } = makeKhContext({ cwd: khHome.dir, khHome: khHome.dir });
      ctx.spawnBackground?.(["hook", "sync"], { cwd: "/some/repo", logFile: "/some/repo/.kanban-hub/hook.log" });
      expect(spawnCalls).toEqual([{ args: ["hook", "sync"], cwd: "/some/repo", logFile: "/some/repo/.kanban-hub/hook.log" }]);
    } finally {
      await khHome.cleanup();
    }
  });

  it("传入 now 时，ctx.now() 使用注入的时间", async () => {
    const khHome = await makeTempKhHome();
    try {
      const fixed = new Date("2026-01-01T00:00:00.000Z");
      const { ctx } = makeKhContext({ cwd: khHome.dir, khHome: khHome.dir, now: () => fixed });
      expect(ctx.now()).toEqual(fixed);
    } finally {
      await khHome.cleanup();
    }
  });

  it("默认 homeDir 由 cleanupDefaultHomeDirs 清理（测试文件结束时也会自动调用）", async () => {
    const khHome = await makeTempKhHome();
    try {
      const { ctx } = makeKhContext({ cwd: khHome.dir, khHome: khHome.dir });
      await fs.access(ctx.homeDir);
      await cleanupDefaultHomeDirs();
      await expect(fs.access(ctx.homeDir)).rejects.toThrow();
    } finally {
      await khHome.cleanup();
    }
  });
});
