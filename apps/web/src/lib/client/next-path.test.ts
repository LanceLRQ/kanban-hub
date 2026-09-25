import { describe, expect, it } from "vitest";
import { sanitizeNextPath } from "./next-path";

describe("sanitizeNextPath", () => {
  it("站内相对路径原样通过", () => {
    expect(sanitizeNextPath("/p/x")).toBe("/p/x");
  });

  it("协议相对 URL 退回默认路径", () => {
    expect(sanitizeNextPath("//evil.com")).toBe("/");
  });

  it("绝对 URL 退回默认路径", () => {
    expect(sanitizeNextPath("https://evil.com")).toBe("/");
  });

  it("javascript: 伪协议退回默认路径", () => {
    expect(sanitizeNextPath("javascript:alert(1)")).toBe("/");
  });

  it("缺省或空串退回默认路径", () => {
    expect(sanitizeNextPath(null)).toBe("/");
    expect(sanitizeNextPath(undefined)).toBe("/");
    expect(sanitizeNextPath("")).toBe("/");
  });

  it("反斜杠开头（会被 URL 解析成协议相对 URL）退回默认路径", () => {
    expect(sanitizeNextPath("/\\evil.com")).toBe("/");
  });

  it("不以 / 开头的反斜杠形式同样退回默认路径", () => {
    expect(sanitizeNextPath("\\\\evil.com")).toBe("/");
  });

  it("URL 编码的反斜杠（%5C）解码后识别为不安全", () => {
    expect(sanitizeNextPath("/%5Cevil.com")).toBe("/");
  });

  it("URL 编码的双斜杠（%2F%2F）解码后识别为不安全", () => {
    expect(sanitizeNextPath("/%2F%2Fevil.com")).toBe("/");
  });

  it("包含制表符的值退回默认路径", () => {
    expect(sanitizeNextPath("/p/x\ty")).toBe("/");
  });

  it("包含换行的值退回默认路径", () => {
    expect(sanitizeNextPath("/p/x\ny")).toBe("/");
  });

  it("非法的百分号编码（无法解码）退回默认路径", () => {
    expect(sanitizeNextPath("/%")).toBe("/");
  });

  it("路径中间出现反斜杠也退回默认路径", () => {
    expect(sanitizeNextPath("/p/x\\y")).toBe("/");
  });
});
