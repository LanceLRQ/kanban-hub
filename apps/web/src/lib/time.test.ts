import { describe, expect, it } from "vitest";
import { dayKey, formatDate, formatDayHeading, formatRelative, formatTime, formatToday, serverTimeZone } from "./time";

describe("serverTimeZone", () => {
  it("取 Intl 解析出的本机时区", () => {
    expect(serverTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});

describe("dayKey", () => {
  it("同一个时间戳在 UTC 和 Asia/Shanghai 跨午夜时，结果不同", () => {
    const iso = "2026-09-24T20:00:00.000Z"; // Shanghai 本地已经是次日 04:00
    expect(dayKey(iso, "UTC")).toBe("2026-09-24");
    expect(dayKey(iso, "Asia/Shanghai")).toBe("2026-09-25");
  });
});

describe("formatDate", () => {
  it("同一年不带年份", () => {
    expect(formatDate("2026-09-20T10:00:00.000Z", "UTC", new Date("2026-09-24T10:00:00.000Z"))).toBe("9 月 20 日");
  });

  it("不是今年时带上年份", () => {
    expect(formatDate("2025-09-24T10:00:00.000Z", "UTC", new Date("2026-09-24T10:00:00.000Z"))).toBe("2025 年 9 月 24 日");
  });
});

describe("formatTime", () => {
  it("按时区格式化成 HH:mm", () => {
    const iso = "2026-09-24T14:02:00.000Z";
    expect(formatTime(iso, "UTC")).toBe("14:02");
    expect(formatTime(iso, "Asia/Shanghai")).toBe("22:02");
  });
});

describe("formatDayHeading", () => {
  it("同一个时间戳跨午夜时，UTC 与 Asia/Shanghai 的分组标题不同", () => {
    const iso = "2026-09-24T20:00:00.000Z";
    const now = new Date("2026-09-25T01:00:00.000Z");
    // UTC：事件是 09-24，现在是 09-25 → 昨天
    expect(formatDayHeading(iso, "UTC", now)).toBe("昨天 · 9 月 24 日");
    // Asia/Shanghai：事件本地已经是 09-25，和现在同一天 → 今天
    expect(formatDayHeading(iso, "Asia/Shanghai", now)).toBe("今天 · 9 月 25 日");
  });

  it("更早的日期不带今天/昨天前缀，跨年时带年份", () => {
    const heading = formatDayHeading("2025-01-01T00:00:00.000Z", "UTC", new Date("2026-09-25T00:00:00.000Z"));
    expect(heading).toBe("2025 年 1 月 1 日");
  });
});

describe("formatToday", () => {
  it("同一个瞬间在不同时区可能是不同的星期", () => {
    const now = new Date("2026-09-24T16:30:00.000Z");
    expect(formatToday(now, "UTC")).toBe("2026 年 9 月 24 日（周四）");
    expect(formatToday(now, "Asia/Shanghai")).toBe("2026 年 9 月 25 日（周五）");
  });
});

describe("formatRelative", () => {
  const now = new Date("2026-09-24T12:00:00.000Z");
  const secondsAgo = (s: number) => new Date(now.getTime() - s * 1000).toISOString();

  it("跨午夜不改变分档：服务端时区昨天 22:00 的事件，今天 01:00 查询仍是“N 小时前”", () => {
    // 用 Asia/Shanghai（UTC+8）本地时间构造：昨天 22:00 → 今天 01:00，本地日历日跨了一天，经过的时间是 3 小时
    const localYesterday2200 = new Date("2026-09-23T14:00:00.000Z"); // Asia/Shanghai 2026-09-23 22:00
    const localToday0100 = new Date("2026-09-23T17:00:00.000Z"); // Asia/Shanghai 2026-09-24 01:00
    expect(formatRelative(localYesterday2200, localToday0100)).toBe("3 小时前");
  });

  it("59 秒内写刚刚", () => {
    expect(formatRelative(secondsAgo(59), now)).toBe("刚刚");
  });

  it("60 秒时进入分钟档", () => {
    expect(formatRelative(secondsAgo(60), now)).toBe("1 分钟前");
  });

  it("59 分钟时仍是分钟档", () => {
    expect(formatRelative(secondsAgo(59 * 60), now)).toBe("59 分钟前");
  });

  it("60 分钟时进入小时档", () => {
    expect(formatRelative(secondsAgo(60 * 60), now)).toBe("1 小时前");
  });

  it("不满 24 小时仍是小时档", () => {
    expect(formatRelative(secondsAgo(24 * 60 * 60 - 1), now)).toBe("23 小时前");
  });

  it("满 24 小时进入天数档", () => {
    expect(formatRelative(secondsAgo(24 * 60 * 60), now)).toBe("1 天前");
  });

  it("不满 30 天仍是天数档", () => {
    expect(formatRelative(secondsAgo(30 * 24 * 60 * 60 - 1), now)).toBe("29 天前");
  });

  it("满 30 天改用日期，不再是相对时间描述", () => {
    const result = formatRelative(secondsAgo(30 * 24 * 60 * 60), now);
    expect(result).not.toContain("前");
    expect(result).not.toBe("刚刚");
    expect(result).toContain("月");
    expect(result).toContain("日");
  });
});
