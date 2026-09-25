import { describe, expect, it } from "vitest";
import { formatCountdown, remainingSeconds } from "./countdown";

describe("remainingSeconds", () => {
  it("到期前：返回剩余的整秒数（向上取整）", () => {
    const now = new Date("2026-09-25T10:00:00.000Z");
    expect(remainingSeconds("2026-09-25T10:00:30.500Z", now)).toBe(31);
  });

  it("恰好到期：返回 0", () => {
    const now = new Date("2026-09-25T10:00:00.000Z");
    expect(remainingSeconds("2026-09-25T10:00:00.000Z", now)).toBe(0);
  });

  it("已过期：返回 0，不返回负数", () => {
    const now = new Date("2026-09-25T10:00:30.000Z");
    expect(remainingSeconds("2026-09-25T10:00:00.000Z", now)).toBe(0);
  });
});

describe("formatCountdown", () => {
  it("格式化成 分:秒，秒数补零", () => {
    expect(formatCountdown(65)).toBe("1:05");
    expect(formatCountdown(9)).toBe("0:09");
    expect(formatCountdown(0)).toBe("0:00");
  });
});
