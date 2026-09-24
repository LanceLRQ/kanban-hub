import { describe, expect, it } from "vitest";
import { generateId, idSchema, shortIdPrefixes } from "./ids";

describe("generateId", () => {
  it("生成 10 位小写字母或数字", () => {
    for (let i = 0; i < 100; i++) expect(generateId()).toMatch(/^[0-9a-z]{10}$/);
  });

  it("1000 个 ID 互不重复", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateId()));
    expect(ids.size).toBe(1000);
  });

  it("字节按 36 取模映射到字符", () => {
    expect(generateId(() => Uint8Array.from([35, 36, 71, 251, 10, 11, 12, 13, 14, 15]))).toBe("z0zzabcdef");
  });

  it("丢弃 252 及以上的字节，避免取模偏差", () => {
    const batches = [new Uint8Array(10).fill(255), Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])];
    let i = 0;
    expect(generateId(() => batches[i++]!)).toBe("0123456789");
  });
});

describe("idSchema", () => {
  it("只接受 10 位小写字母或数字", () => {
    expect(idSchema.safeParse("k3v9x2m7qa").success).toBe(true);
    expect(idSchema.safeParse("K3V9X2M7QA").success).toBe(false);
    expect(idSchema.safeParse("k3v9").success).toBe(false);
  });
});

describe("shortIdPrefixes", () => {
  it("取至少 4 位、能互相区分的最短前缀", () => {
    const m = shortIdPrefixes(["k3v9x2m7qa", "k3v9y1aaaa", "abcd123456"]);
    expect(m.get("k3v9x2m7qa")).toBe("k3v9x");
    expect(m.get("k3v9y1aaaa")).toBe("k3v9y");
    expect(m.get("abcd123456")).toBe("abcd");
  });

  it("只有一个 ID 时取 4 位", () => {
    expect(shortIdPrefixes(["k3v9x2m7qa"]).get("k3v9x2m7qa")).toBe("k3v9");
  });

  it("可以指定更长的最短长度", () => {
    expect(shortIdPrefixes(["abcd123456"], 6).get("abcd123456")).toBe("abcd12");
  });
});
