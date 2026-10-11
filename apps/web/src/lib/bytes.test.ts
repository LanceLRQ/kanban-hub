import { describe, expect, it } from "vitest";
import { formatBytes } from "./bytes";

describe("formatBytes", () => {
  it("不足 1 KB 用 B（四舍五入到整数）", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023.6)).toBe("1024 B");
  });

  it("KB 起保留一位小数，整数位到三位起四舍五入到整数", () => {
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024)).toBe("1 MB");
    expect(formatBytes(1024 * 1024 * 1024 * 2.5)).toBe("2.5 GB");
    expect(formatBytes(1024 * 1024 * 123.456)).toBe("123 MB");
    expect(formatBytes(1024 * 1024 * 999)).toBe("999 MB");
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1 GB");
  });

  it("超过 TB 也不溢出单位，负数与非数值按 0 处理", () => {
    expect(formatBytes(1024 ** 5)).toBe("1024 TB");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });
});
