import { describe, expect, it } from "vitest";
import { KH_VERSION, isCompatibleVersion } from "./version";

describe("isCompatibleVersion", () => {
  it("主版本号为 0 时要求次版本号相同", () => {
    expect(isCompatibleVersion("0.1.0", "0.1.5")).toBe(true);
    expect(isCompatibleVersion("0.1.0", "0.2.0")).toBe(false);
  });

  it("主版本号不为 0 时只要求主版本号相同", () => {
    expect(isCompatibleVersion("1.2.0", "1.9.3")).toBe(true);
    expect(isCompatibleVersion("1.2.0", "2.0.0")).toBe(false);
  });

  it("允许预发布与构建后缀", () => {
    expect(isCompatibleVersion("0.1.0-beta.1", "0.1.0")).toBe(true);
    expect(isCompatibleVersion("0.1.0+build.7", "0.1.2")).toBe(true);
  });

  it("格式不合法时视为不兼容", () => {
    expect(isCompatibleVersion("abc", "0.1.0")).toBe(false);
    expect(isCompatibleVersion("0.1", "0.1.0")).toBe(false);
    expect(isCompatibleVersion("0.1.0", "")).toBe(false);
  });

  it("KH_VERSION 本身是合法版本号", () => {
    expect(isCompatibleVersion(KH_VERSION, KH_VERSION)).toBe(true);
  });
});
