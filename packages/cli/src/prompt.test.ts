import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { CliContext } from "./context";
import { EXIT } from "./errors";
import { confirm } from "./prompt";

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
