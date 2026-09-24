import { describe, expect, it } from "vitest";
import { clientKey, FailureLimiter } from "./rate-limit";

/** 固定起点、可手动前进的时钟，用于精确控制窗口边界 */
function mutableClock(iso: string): { now: () => Date; advance: (ms: number) => void } {
  let current = Date.parse(iso);
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe("FailureLimiter", () => {
  it("同一个 key 第 5 次失败之后被拦截", () => {
    const c = mutableClock("2026-09-24T00:00:00.000Z");
    const limiter = new FailureLimiter({ now: c.now });

    for (let i = 0; i < 4; i++) limiter.recordFailure("1.2.3.4");
    expect(limiter.check("1.2.3.4")).toEqual({ blocked: false });

    limiter.recordFailure("1.2.3.4");
    expect(limiter.check("1.2.3.4")).toMatchObject({ blocked: true });
  });

  it("换一个 key 不受影响", () => {
    const c = mutableClock("2026-09-24T00:00:00.000Z");
    const limiter = new FailureLimiter({ now: c.now });

    for (let i = 0; i < 5; i++) limiter.recordFailure("1.2.3.4");
    expect(limiter.check("1.2.3.4")).toMatchObject({ blocked: true });
    expect(limiter.check("5.6.7.8")).toEqual({ blocked: false });
  });

  it("达到全局上限后所有 key 都被拦截", () => {
    const c = mutableClock("2026-09-24T00:00:00.000Z");
    const limiter = new FailureLimiter({ now: c.now, perKeyLimit: 5, globalLimit: 30 });

    // 10 个 key 各失败 3 次，凑够全局 30 次，但不会碰到单 key 上限（5 次）
    for (let i = 0; i < 30; i++) limiter.recordFailure(`key-${i % 10}`);

    expect(limiter.check("key-0")).toMatchObject({ blocked: true });
    expect(limiter.check("brand-new-key")).toMatchObject({ blocked: true });
  });

  it("过了窗口期恢复", () => {
    const c = mutableClock("2026-09-24T00:00:00.000Z");
    const limiter = new FailureLimiter({ now: c.now, windowMs: 60_000 });

    for (let i = 0; i < 5; i++) limiter.recordFailure("1.2.3.4");
    expect(limiter.check("1.2.3.4")).toMatchObject({ blocked: true });

    c.advance(60_000 + 1);
    expect(limiter.check("1.2.3.4")).toEqual({ blocked: false });
  });

  it("只统计失败，check 本身不计入失败也不会清零", () => {
    const c = mutableClock("2026-09-24T00:00:00.000Z");
    const limiter = new FailureLimiter({ now: c.now });

    for (let i = 0; i < 4; i++) limiter.recordFailure("1.2.3.4");
    // 模拟多次成功登录检查：只调用 check，不产生失败
    for (let i = 0; i < 10; i++) expect(limiter.check("1.2.3.4")).toEqual({ blocked: false });

    limiter.recordFailure("1.2.3.4");
    expect(limiter.check("1.2.3.4")).toMatchObject({ blocked: true });
  });

  it("retryAfterSec 大于 0 且不超过窗口长度", () => {
    const c = mutableClock("2026-09-24T00:00:00.000Z");
    const windowMs = 60_000;
    const limiter = new FailureLimiter({ now: c.now, windowMs });

    for (let i = 0; i < 5; i++) {
      limiter.recordFailure("1.2.3.4");
      c.advance(1000);
    }

    const result = limiter.check("1.2.3.4");
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.retryAfterSec).toBeGreaterThan(0);
      expect(result.retryAfterSec).toBeLessThanOrEqual(windowMs / 1000);
    }
  });
});

describe("clientKey", () => {
  it("优先取 X-Forwarded-For 的第一段", () => {
    const headers = new Headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8", "x-real-ip": "9.9.9.9" });
    expect(clientKey(headers)).toBe("1.2.3.4");
  });

  it("X-Forwarded-For 只有一段时直接取用", () => {
    const headers = new Headers({ "x-forwarded-for": "1.2.3.4" });
    expect(clientKey(headers)).toBe("1.2.3.4");
  });

  it("没有 X-Forwarded-For 时取 X-Real-IP", () => {
    const headers = new Headers({ "x-real-ip": "9.9.9.9" });
    expect(clientKey(headers)).toBe("9.9.9.9");
  });

  it("都没有时返回 unknown", () => {
    const headers = new Headers();
    expect(clientKey(headers)).toBe("unknown");
  });
});
