import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { KH_VERSION } from "@kanban-hub/core/version";
import type { CliContext } from "./context";
import { CliError, EXIT } from "./errors";
import { main, runProgram } from "./main";

function fakeContext(): { ctx: CliContext; stdout: () => string; stderr: () => string } {
  let stdout = "";
  let stderr = "";
  const ctx: CliContext = {
    cwd: "/tmp",
    env: {},
    stdout: { write: (s) => { stdout += s; } },
    stderr: { write: (s) => { stderr += s; } },
    stdin: process.stdin,
    isTTY: false,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    platform: "linux",
    hostname: "test-host",
    homeDir: "/home/test-user",
    fetch: (() => {
      throw new Error("不应该在 main 测试里调用 fetch");
    }) as unknown as typeof fetch,
  };
  return { ctx, stdout: () => stdout, stderr: () => stderr };
}

describe("main", () => {
  it("--version 与 -v 返回 0，输出版本号", async () => {
    const a = fakeContext();
    expect(await main(["--version"], a.ctx)).toBe(0);
    expect(a.stdout().trim()).toBe(KH_VERSION);

    const b = fakeContext();
    expect(await main(["-v"], b.ctx)).toBe(0);
    expect(b.stdout().trim()).toBe(KH_VERSION);
  });

  it("--help 返回 0", async () => {
    const a = fakeContext();
    expect(await main(["--help"], a.ctx)).toBe(0);
    expect(a.stdout()).toContain("kanban-hub 命令行");
  });

  it("未知选项返回 2，stderr 以 错误： 开头", async () => {
    const a = fakeContext();
    expect(await main(["--totally-bogus"], a.ctx)).toBe(EXIT.USAGE);
    expect(a.stderr().startsWith("错误：")).toBe(true);
  });

  it("未知命令返回 2，stderr 以 错误： 开头", async () => {
    const a = fakeContext();
    expect(await main(["totally-bogus-command"], a.ctx)).toBe(EXIT.USAGE);
    expect(a.stderr().startsWith("错误：")).toBe(true);
  });
});

describe("runProgram", () => {
  it("命令抛出 CliError 时返回它自带的退出码，提示行以 提示： 开头", async () => {
    const a = fakeContext();
    const program = new Command()
      .exitOverride()
      .action(() => {
        throw new CliError(EXIT.DATA, "找不到任务", "检查任务引用是否正确");
      });
    expect(await runProgram(program, [], a.ctx)).toBe(EXIT.DATA);
    expect(a.stderr()).toBe("错误：找不到任务\n提示：检查任务引用是否正确\n");
  });

  it("命令抛出没有 hint 的 CliError 时不输出提示行", async () => {
    const a = fakeContext();
    const program = new Command()
      .exitOverride()
      .action(() => {
        throw new CliError(EXIT.AUTH, "未登录");
      });
    expect(await runProgram(program, [], a.ctx)).toBe(EXIT.AUTH);
    expect(a.stderr()).toBe("错误：未登录\n");
  });

  it("命令抛出普通异常时返回 1", async () => {
    const a = fakeContext();
    const program = new Command()
      .exitOverride()
      .action(() => {
        throw new Error("坏事发生了");
      });
    expect(await runProgram(program, [], a.ctx)).toBe(EXIT.UNEXPECTED);
    expect(a.stderr()).toBe("错误：坏事发生了\n");
  });

  it("命令正常执行时返回 0", async () => {
    const a = fakeContext();
    const program = new Command().exitOverride().action(() => {});
    expect(await runProgram(program, [], a.ctx)).toBe(EXIT.OK);
  });
});
