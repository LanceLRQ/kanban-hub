import os from "node:os";
import { describe, expect, it } from "vitest";
import { createNodeContext } from "./context";

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
});
