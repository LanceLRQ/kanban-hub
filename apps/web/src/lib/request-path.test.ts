import { describe, expect, it } from "vitest";
import { buildForwardedPath, resolveForwardedPath } from "./request-path";

describe("buildForwardedPath", () => {
  it("拼接 pathname 和 search", () => {
    expect(buildForwardedPath("/p/x", "?task=t1")).toBe("/p/x?task=t1");
  });

  it("search 为空串时只有 pathname", () => {
    expect(buildForwardedPath("/p/x", "")).toBe("/p/x");
  });

  it("拼接结果不合法（例如带反斜杠）时退回 /", () => {
    expect(buildForwardedPath("/p/x", "?a=\\evil")).toBe("/");
  });
});

describe("resolveForwardedPath：布局取值的回退逻辑", () => {
  it("读到合法路径时原样使用", () => {
    expect(resolveForwardedPath("/p/x")).toBe("/p/x");
  });

  it("读不到请求头（null）时退回 /", () => {
    expect(resolveForwardedPath(null)).toBe("/");
  });

  it("读到的值不是合法的站内路径时也退回 /（双重防御）", () => {
    expect(resolveForwardedPath("/\\evil.com")).toBe("/");
    expect(resolveForwardedPath("https://evil.com")).toBe("/");
  });
});
