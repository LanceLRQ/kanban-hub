import os from "node:os";
import { describe, expect, it } from "vitest";
import { createNodeContext, type Writer } from "./context";

describe("createNodeContext", () => {
  it("反映真实进程的 cwd、env、platform、hostname、homeDir", () => {
    const ctx = createNodeContext();
    expect(ctx.cwd).toBe(process.cwd());
    expect(ctx.env).toBe(process.env);
    expect(ctx.platform).toBe(process.platform);
    expect(ctx.hostname).toBe(os.hostname());
    expect(ctx.homeDir).toBe(os.homedir());
  });

  it("now() 返回当前时间", () => {
    const ctx = createNodeContext();
    const before = Date.now();
    const now = ctx.now().getTime();
    const after = Date.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });

  it("提供可用的 fetch", () => {
    const ctx = createNodeContext();
    expect(typeof ctx.fetch).toBe("function");
  });

  it("isTTY 反映 stdin.isTTY", () => {
    const ctx = createNodeContext();
    expect(ctx.isTTY).toBe(Boolean(process.stdin.isTTY));
  });

  it("提供可用的 spawnBackground", () => {
    const ctx = createNodeContext();
    expect(typeof ctx.spawnBackground).toBe("function");
  });
});

describe("Writer", () => {
  it("只收字符串的 writer 不能当作能收字节数组的 writer 使用（属性写法下的逆变检查）", () => {
    function acceptsBytes(writer: Writer): void {
      writer.write(new Uint8Array([1, 2, 3]));
    }
    const stringOnlyWriter = { write: (_s: string) => {} };
    // @ts-expect-error 只收字符串的 write 不满足 Writer（收字符串或字节数组）
    acceptsBytes(stringOnlyWriter);
  });
});
