import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { CliContext } from "./context";
import { EXIT } from "./errors";
import { confirm, readPassword } from "./prompt";

function fakeContext(overrides: Partial<CliContext> = {}): CliContext {
  return {
    cwd: "/tmp",
    env: {},
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    stdin: new PassThrough(),
    isTTY: true,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    platform: "linux",
    hostname: "test-host",
    homeDir: "/home/test-user",
    fetch: (() => {
      throw new Error("不应该在 prompt 测试里调用 fetch");
    }) as unknown as typeof fetch,
    ...overrides,
  };
}

describe("confirm", () => {
  it("非交互环境直接抛用法错误，提示加 --yes", async () => {
    const ctx = fakeContext({ isTTY: false });
    await expect(confirm(ctx, "确定吗？")).rejects.toThrowError(
      expect.objectContaining({ exitCode: EXIT.USAGE }),
    );
  });

  it.each([
    ["y", true],
    ["YES", true],
    ["n", false],
    ["", false],
  ])("交互时输入 %s 的结果是 %s", async (input, expected) => {
    const stdin = new PassThrough();
    const ctx = fakeContext({ stdin, isTTY: true });
    const resultPromise = confirm(ctx, "确定吗？");
    stdin.end(`${input}\n`);
    await expect(resultPromise).resolves.toBe(expected);
  });

  it("把问题写到 stdout", async () => {
    let written = "";
    const stdin = new PassThrough();
    const ctx = fakeContext({
      stdin,
      isTTY: true,
      stdout: { write: (s) => { written += s; } },
    });
    const resultPromise = confirm(ctx, "确定吗？");
    stdin.end("y\n");
    await resultPromise;
    expect(written).toContain("确定吗？");
  });
});

describe("readPassword", () => {
  it("非交互环境抛用法错误（2），提示需要在终端里运行", async () => {
    const ctx = fakeContext({ isTTY: false });
    await expect(readPassword(ctx, "密码：")).rejects.toThrowError(
      expect.objectContaining({ exitCode: EXIT.USAGE, message: expect.stringContaining("终端") }),
    );
  });

  it("读到输入的密码；stdout 只有提示，密码不回显", async () => {
    let written = "";
    const stdin = new PassThrough();
    const ctx = fakeContext({
      stdin,
      isTTY: true,
      stdout: { write: (s) => { written += s; } },
    });
    const resultPromise = readPassword(ctx, "设置备份密码：");
    stdin.end("秘密密码\n");
    await expect(resultPromise).resolves.toBe("秘密密码");
    expect(written).toBe("设置备份密码：");
  });

  it("输入流提前结束（Ctrl+D）时报用法错误，不当作空密码", async () => {
    const stdin = new PassThrough();
    const ctx = fakeContext({ stdin, isTTY: true });
    const resultPromise = readPassword(ctx, "密码：");
    stdin.end();
    await expect(resultPromise).rejects.toThrowError(expect.objectContaining({ exitCode: EXIT.USAGE }));
  });

  it("Ctrl+C 取消输入：立即结束不挂起，按已取消报用法错误（2）", async () => {
    let written = "";
    const stdin = new PassThrough();
    const ctx = fakeContext({
      stdin,
      isTTY: true,
      stdout: { write: (s) => { written += s; } },
    });
    const resultPromise = readPassword(ctx, "密码：");
    stdin.write("\x03");
    await expect(resultPromise).rejects.toThrowError(
      expect.objectContaining({ exitCode: EXIT.USAGE, message: expect.stringContaining("已取消") }),
    );
    expect(written).toBe("密码：");
  });
});
