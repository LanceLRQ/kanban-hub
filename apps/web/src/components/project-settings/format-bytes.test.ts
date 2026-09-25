import { describe, expect, it } from "vitest";
import { formatBytes } from "./format-bytes";

describe("formatBytes", () => {
  it("小于 1000 字节时直接显示字节数", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  it("按 1000 进制换算到 KB/MB/GB", () => {
    expect(formatBytes(2_500)).toBe("2.5 KB");
    expect(formatBytes(20_000_000)).toBe("20.0 MB");
    expect(formatBytes(3_400_000_000)).toBe("3.4 GB");
  });
});
