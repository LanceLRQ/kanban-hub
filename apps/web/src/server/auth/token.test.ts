import { describe, expect, it } from "vitest";
import { generateMachineToken, hashToken, isMachineTokenFormat } from "./token";

describe("generateMachineToken", () => {
  it("格式为 kh_ 加 43 位 base64url", () => {
    const token = generateMachineToken();
    expect(token).toMatch(/^kh_[A-Za-z0-9_-]{43}$/);
  });

  it("多次生成互不相同", () => {
    const tokens = new Set(Array.from({ length: 20 }, () => generateMachineToken()));
    expect(tokens.size).toBe(20);
  });
});

describe("hashToken", () => {
  it("结果稳定，且是 64 位十六进制", () => {
    const token = generateMachineToken();
    const hash = hashToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).toBe(hash);
  });

  it("不同令牌哈希不同", () => {
    expect(hashToken(generateMachineToken())).not.toBe(hashToken(generateMachineToken()));
  });
});

describe("isMachineTokenFormat", () => {
  it("接受合法格式", () => {
    expect(isMachineTokenFormat(generateMachineToken())).toBe(true);
  });

  it("拒绝明显不对的输入", () => {
    expect(isMachineTokenFormat("")).toBe(false);
    expect(isMachineTokenFormat("kh_short")).toBe(false);
    expect(isMachineTokenFormat(`notkh_${"a".repeat(43)}`)).toBe(false);
    expect(isMachineTokenFormat(`kh_${"!".repeat(43)}`)).toBe(false);
    expect(isMachineTokenFormat(`kh_${"a".repeat(44)}`)).toBe(false);
    expect(isMachineTokenFormat(`kh_${"a".repeat(42)}`)).toBe(false);
  });
});
