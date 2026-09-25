import { describe, expect, it } from "vitest";
import { EXIT, type CliError } from "../errors";
import { mapPlatformToOs, normalizeServerUrl } from "./auth";

function captureError(fn: () => unknown): CliError {
  try {
    fn();
  } catch (err) {
    return err as CliError;
  }
  throw new Error("期望抛出异常，但没有抛出");
}

describe("normalizeServerUrl", () => {
  it("去掉末尾的斜杠", () => {
    expect(normalizeServerUrl("http://example.test/")).toBe("http://example.test");
  });

  it("保留 https 和端口号", () => {
    expect(normalizeServerUrl("https://example.test:8443")).toBe("https://example.test:8443");
  });

  it("不是 http/https 时抛 CliError(2)", () => {
    const err = captureError(() => normalizeServerUrl("ftp://example.test"));
    expect(err.exitCode).toBe(EXIT.USAGE);
  });

  it("不是合法 URL 时抛 CliError(2)", () => {
    const err = captureError(() => normalizeServerUrl("不是网址"));
    expect(err.exitCode).toBe(EXIT.USAGE);
  });

  it("带路径时抛 CliError(2)（包括多余的斜杠）", () => {
    expect(captureError(() => normalizeServerUrl("http://example.test/setup")).exitCode).toBe(EXIT.USAGE);
    expect(captureError(() => normalizeServerUrl("http://example.test//")).exitCode).toBe(EXIT.USAGE);
  });

  it("带查询参数或锚点时抛 CliError(2)", () => {
    expect(captureError(() => normalizeServerUrl("http://example.test?x=1")).exitCode).toBe(EXIT.USAGE);
    expect(captureError(() => normalizeServerUrl("http://example.test#frag")).exitCode).toBe(EXIT.USAGE);
  });

  it("带用户名密码时抛 CliError(2)，错误信息不回显密码", () => {
    const err = captureError(() => normalizeServerUrl("http://user:hunter2@example.test"));
    expect(err.exitCode).toBe(EXIT.USAGE);
    expect(err.message).not.toContain("hunter2");
    expect(err.hint ?? "").not.toContain("hunter2");
  });
});

describe("mapPlatformToOs", () => {
  it("darwin → darwin，linux → linux，win32 → windows", () => {
    expect(mapPlatformToOs("darwin")).toBe("darwin");
    expect(mapPlatformToOs("linux")).toBe("linux");
    expect(mapPlatformToOs("win32")).toBe("windows");
  });

  it("不支持的平台抛 CliError(2)", () => {
    const err = captureError(() => mapPlatformToOs("aix"));
    expect(err.exitCode).toBe(EXIT.USAGE);
  });
});
