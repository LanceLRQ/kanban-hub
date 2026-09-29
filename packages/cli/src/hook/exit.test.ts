import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliError, EXIT } from "../errors";
import { fakeContext } from "../repo/test-helpers";
import { createHookLogger, describeHookError, HOOK_LIMITS, HookExit, isHookExit, quietContext } from "./exit";

const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length > 0) await fs.rm(dirs.pop()!, { recursive: true, force: true });
});

async function tempHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kh-hook-exit-"));
  dirs.push(dir);
  return dir;
}

describe("HookExit", () => {
  it("带退出码与原样的 stderr", () => {
    const exit = new HookExit(2, "提醒\n");
    expect(exit.exitCode).toBe(2);
    expect(exit.stderr).toBe("提醒\n");
    expect(isHookExit(exit)).toBe(true);
  });

  it("按全局品牌识别：另一个模块实例创建的同品牌对象也能认出来；普通错误、CliError、null 都不是", () => {
    const foreign = { [Symbol.for("kanban-hub.hook-exit")]: true, exitCode: 2 };
    expect(isHookExit(foreign)).toBe(true);
    expect(isHookExit(new Error("x"))).toBe(false);
    expect(isHookExit(new CliError(EXIT.USAGE, "x"))).toBe(false);
    expect(isHookExit(null)).toBe(false);
    expect(isHookExit("x")).toBe(false);
  });
});

describe("HOOK_LIMITS", () => {
  it("时间预算：硬性兜底落在 15 秒的 hook 超时之内，拉取截止与各请求超时按预算取值", () => {
    expect(HOOK_LIMITS.hardLimitMs).toBe(13_500);
    expect(HOOK_LIMITS.backgroundSyncLimitMs).toBe(300_000);
    expect(HOOK_LIMITS.pullDeadlineMs).toBe(8000);
    expect(HOOK_LIMITS.pullRequestTimeoutMs).toBe(2000);
    expect(HOOK_LIMITS.detailTimeoutMs).toBe(3000);
    expect(HOOK_LIMITS.stdinTimeoutMs).toBe(2000);
    expect(HOOK_LIMITS.stdinMaxBytes).toBe(8 * 1024 * 1024);
    expect(HOOK_LIMITS.summaryMaxLines).toBe(40);
    expect(HOOK_LIMITS.summaryMaxChars).toBe(4000);
    expect(HOOK_LIMITS.pushSkipWindowMs).toBe(600_000);
  });
});

describe("describeHookError", () => {
  it("CliError 带上提示；多行消息压成一行", () => {
    expect(describeHookError(new CliError(EXIT.AUTH, "尚未登录", "执行 kh login"))).toBe("尚未登录（执行 kh login）");
    expect(describeHookError(new Error("第一行\n第二行"))).toBe("第一行 | 第二行");
    expect(describeHookError("字符串")).toBe("字符串");
  });
});

describe("createHookLogger", () => {
  it("按顺序写进 KH_HOME/logs/hook.log，带 hook 名与项目 ID；flush 之后内容已落盘", async () => {
    const home = await tempHome();
    const ctx = fakeContext({ env: { KH_HOME: home }, now: () => new Date("2026-09-29T00:00:00.000Z") });
    const logger = createHookLogger(ctx, "stop");
    expect(logger.path).toBe(path.join(home, "logs", "hook.log"));
    logger.write("第一条");
    logger.setProject("p000000001");
    logger.write("第二条\n换行");
    await logger.flush();
    const text = await fs.readFile(path.join(home, "logs", "hook.log"), "utf8");
    expect(text).toBe(
      "2026-09-29T00:00:00.000Z stop 第一条\n2026-09-29T00:00:00.000Z stop p000000001 第二条 | 换行\n",
    );
  });

  it("quietContext：stdout、stderr 按行转写进日志，不写到原来的流；没有换行结尾的残留在 flush 时写出", async () => {
    const home = await tempHome();
    let realOut = "";
    const ctx = fakeContext({
      env: { KH_HOME: home },
      now: () => new Date("2026-09-29T00:00:00.000Z"),
      stdout: { write: (s) => void (realOut += String(s)) },
      stderr: { write: (s) => void (realOut += String(s)) },
    });
    const logger = createHookLogger(ctx, "session-start");
    const quiet = quietContext(ctx, logger);
    quiet.stderr.write("警告：一\n警告");
    quiet.stdout.write(new TextEncoder().encode("：二\n残留"));
    await logger.flush();
    expect(realOut).toBe("");
    const lines = (await fs.readFile(logger.path!, "utf8")).trimEnd().split("\n");
    expect(lines.map((l) => l.split(" ").slice(2).join(" "))).toEqual(["警告：一", "警告：二", "残留"]);
  });

  it("找不到 KH_HOME 时不抛错：path 为 null，写入被忽略", async () => {
    const ctx = fakeContext({ env: {}, homeDir: "" });
    const logger = createHookLogger(ctx, "stop");
    expect(logger.path).toBeNull();
    logger.write("x");
    await expect(logger.flush()).resolves.toBeUndefined();
  });
});
