import { Command, Option } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("未知选项返回 2，stderr 是中文翻译", async () => {
    const a = fakeContext();
    expect(await main(["--totally-bogus"], a.ctx)).toBe(EXIT.USAGE);
    expect(a.stderr()).toBe("错误：未知选项 '--totally-bogus'\n");
  });

  it("未知命令返回 2，stderr 是中文翻译", async () => {
    const a = fakeContext();
    expect(await main(["totally-bogus-command"], a.ctx)).toBe(EXIT.USAGE);
    expect(a.stderr()).toBe("错误：未知命令 'totally-bogus-command'\n");
  });
});

describe("commander 内置错误的中文翻译", () => {
  function buildErrorTestProgram(): Command {
    return new Command()
      .name("root")
      .exitOverride()
      .argument("<必需参数>", "必需参数")
      .requiredOption("--code <配对码>", "必需选项")
      .action(() => {});
  }

  it("缺少必需的参数：翻译成中文", async () => {
    const a = fakeContext();
    expect(await runProgram(buildErrorTestProgram(), ["--code", "x"], a.ctx)).toBe(EXIT.USAGE);
    expect(a.stderr()).toContain("错误：缺少必需的参数 '必需参数'");
  });

  it("缺少必需的选项：翻译成中文", async () => {
    const a = fakeContext();
    expect(await runProgram(buildErrorTestProgram(), ["值"], a.ctx)).toBe(EXIT.USAGE);
    expect(a.stderr()).toContain("错误：缺少必需的选项 '--code <配对码>'");
  });

  it("选项缺少参数值：翻译成中文", async () => {
    const a = fakeContext();
    expect(await runProgram(buildErrorTestProgram(), ["值", "--code"], a.ctx)).toBe(EXIT.USAGE);
    expect(a.stderr()).toContain("错误：选项 '--code <配对码>' 缺少参数值");
  });

  it("参数太多：翻译成中文", async () => {
    const a = fakeContext();
    expect(await runProgram(buildErrorTestProgram(), ["值", "多余的", "--code", "x"], a.ctx)).toBe(EXIT.USAGE);
    expect(a.stderr()).toContain("错误：参数太多");
    expect(a.stderr()).toContain("预期 1 个，实际收到 2 个：值, 多余的");
  });

  it("选项冲突：翻译成中文", async () => {
    const a = fakeContext();
    const program = new Command()
      .name("root")
      .exitOverride()
      .addOption(new Option("--a", "选项 a").conflicts("b"))
      .addOption(new Option("--b", "选项 b"))
      .action(() => {});
    expect(await runProgram(program, ["--a", "--b"], a.ctx)).toBe(EXIT.USAGE);
    expect(a.stderr()).toContain("不能和");
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

/**
 * commander 15 的 `.command()` 在创建子命令那一刻用 copyInheritedSettings() 复制父命令
 * *当时* 的 _outputConfiguration/_exitCallback；根命令后来才调用的 exitOverride/configureOutput
 * 不会回头影响已经创建的子命令。这里手工拼一棵“根 -> child -> grand”的命令树（不经过
 * buildProgram，覆盖“以后新增的命令”这种一般情况），验证 runProgram 对每一层都生效：
 * 子命令、孙命令的用法错误也要落到退出码 2、stderr 以“错误：”开头，并且真的不调用
 * process.exit（用 spy 顶掉它，防止一旦回归真的杀掉测试进程）。
 */
function buildNestedTestProgram(): Command {
  const root = new Command().name("root");
  const child = root
    .command("child")
    .requiredOption("--code <配对码>", "必需的配对码")
    .action(() => {});
  child
    .command("grand")
    .requiredOption("--code <配对码>", "必需的配对码")
    .action(() => {});
  return root;
}

describe("runProgram 对子命令、孙命令同样生效", () => {
  let exitSpy: ReturnType<typeof vi.spyOn> | undefined;

  afterEach(() => {
    exitSpy?.mockRestore();
    exitSpy = undefined;
  });

  // 用 spy 顶掉 process.exit：一旦“递归 attachOutput”这个修复回归，commander 会真的调用
  // process.exit 杀掉这个 worker 进程，spy 能安全拦下来并证明它被调用过
  function spyOnProcessExit(): ReturnType<typeof vi.spyOn> {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    return exitSpy;
  }

  it("子命令缺少必需选项：返回 2，stderr 以 错误： 开头，不调用 process.exit", async () => {
    const spy = spyOnProcessExit();
    const a = fakeContext();
    expect(await runProgram(buildNestedTestProgram(), ["child"], a.ctx)).toBe(EXIT.USAGE);
    expect(a.stderr().startsWith("错误：")).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it("子命令的选项缺参数：返回 2，stderr 以 错误： 开头，不调用 process.exit", async () => {
    const spy = spyOnProcessExit();
    const a = fakeContext();
    expect(await runProgram(buildNestedTestProgram(), ["child", "--code"], a.ctx)).toBe(EXIT.USAGE);
    expect(a.stderr().startsWith("错误：")).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it("子命令上的未知选项：返回 2，stderr 以 错误： 开头，不调用 process.exit", async () => {
    const spy = spyOnProcessExit();
    const a = fakeContext();
    expect(await runProgram(buildNestedTestProgram(), ["child", "--code", "x", "--bogus"], a.ctx)).toBe(EXIT.USAGE);
    expect(a.stderr().startsWith("错误：")).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it("孙命令缺少必需选项：同样返回 2，stderr 以 错误： 开头，不调用 process.exit", async () => {
    const spy = spyOnProcessExit();
    const a = fakeContext();
    expect(await runProgram(buildNestedTestProgram(), ["child", "--code", "x", "grand"], a.ctx)).toBe(EXIT.USAGE);
    expect(a.stderr().startsWith("错误：")).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it("孙命令上的未知选项：同样返回 2，不调用 process.exit", async () => {
    const spy = spyOnProcessExit();
    const a = fakeContext();
    expect(
      await runProgram(buildNestedTestProgram(), ["child", "--code", "x", "grand", "--code", "y", "--bogus"], a.ctx),
    ).toBe(EXIT.USAGE);
    expect(a.stderr().startsWith("错误：")).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it("子命令的 --help 返回 0", async () => {
    const a = fakeContext();
    expect(await runProgram(buildNestedTestProgram(), ["child", "--help"], a.ctx)).toBe(EXIT.OK);
    expect(a.stdout()).toContain("Usage:");
  });

  it("孙命令的 --help 返回 0", async () => {
    const a = fakeContext();
    expect(await runProgram(buildNestedTestProgram(), ["child", "--code", "x", "grand", "--help"], a.ctx)).toBe(
      EXIT.OK,
    );
    expect(a.stdout()).toContain("Usage:");
  });
});
