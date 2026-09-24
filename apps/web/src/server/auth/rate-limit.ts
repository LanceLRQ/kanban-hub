/** 每个 key 在窗口内允许的失败次数 */
const DEFAULT_PER_KEY_LIMIT = 5;
/** 所有 key 加在一起、窗口内允许的失败次数 */
const DEFAULT_GLOBAL_LIMIT = 30;
/** 滑动窗口长度 */
const DEFAULT_WINDOW_MS = 60_000;
/** 每记录这么多次失败，顺带做一次全量清扫；伪造 X-Forwarded-For 也只能让内存增长到这个量级 */
const DEFAULT_SWEEP_EVERY = 500;

export type FailureCheckResult = { blocked: false } | { blocked: true; retryAfterSec: number };

/** 基于滑动窗口的失败次数限流：只统计失败，成功不清零，窗口过去后自动恢复 */
export class FailureLimiter {
  private readonly now: () => Date;
  private readonly perKeyLimit: number;
  private readonly globalLimit: number;
  private readonly windowMs: number;
  private readonly sweepEvery: number;
  /** 每个 key 的失败时间戳（毫秒），按时间升序 */
  private readonly perKey = new Map<string, number[]>();
  /** 全部 key 加在一起的失败时间戳，按时间升序 */
  private global: number[] = [];
  /** 距离上一次全量清扫已经记录了多少次失败 */
  private sinceLastSweep = 0;

  constructor(opts: {
    now: () => Date;
    perKeyLimit?: number;
    globalLimit?: number;
    windowMs?: number;
    sweepEvery?: number;
  }) {
    this.now = opts.now;
    this.perKeyLimit = opts.perKeyLimit ?? DEFAULT_PER_KEY_LIMIT;
    this.globalLimit = opts.globalLimit ?? DEFAULT_GLOBAL_LIMIT;
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.sweepEvery = opts.sweepEvery ?? DEFAULT_SWEEP_EVERY;
  }

  check(key: string): FailureCheckResult {
    const nowMs = this.now().getTime();
    const keyHits = this.activeHitsForKey(key, nowMs);
    const globalHits = this.activeGlobalHits(nowMs);

    const overKey = keyHits.length >= this.perKeyLimit;
    const overGlobal = globalHits.length >= this.globalLimit;
    if (!overKey && !overGlobal) return { blocked: false };

    // 重试等待时间按触发拦截的那个窗口里最早一条失败何时滑出窗口计算
    const earliestHits: number[] = [];
    if (overKey) earliestHits.push(keyHits[0]!);
    if (overGlobal) earliestHits.push(globalHits[0]!);
    const earliest = Math.min(...earliestHits);
    const windowSec = Math.ceil(this.windowMs / 1000);
    const retryAfterSec = Math.min(Math.max(1, Math.ceil((earliest + this.windowMs - nowMs) / 1000)), windowSec);
    return { blocked: true, retryAfterSec };
  }

  recordFailure(key: string): void {
    const nowMs = this.now().getTime();
    const keyHits = this.activeHitsForKey(key, nowMs);
    keyHits.push(nowMs);
    this.perKey.set(key, keyHits);

    this.global = this.activeGlobalHits(nowMs);
    this.global.push(nowMs);

    this.sinceLastSweep++;
    if (this.sinceLastSweep >= this.sweepEvery) {
      this.sinceLastSweep = 0;
      this.sweepExpiredKeys(nowMs);
    }
  }

  /**
   * 撤销 key 最近一次记录的失败，连同全局计数里最近一条。用于并发下抢先占位记的
   * 那一次失败：密码校验通过后撤销，避免误伤同一时间窗口里真正的失败次数。
   */
  forgive(key: string): void {
    const keyHits = this.perKey.get(key);
    if (keyHits && keyHits.length > 0) {
      keyHits.pop();
      if (keyHits.length === 0) this.perKey.delete(key);
    }
    if (this.global.length > 0) this.global.pop();
  }

  /**
   * 只统计失败的账本只在某个 key 被再次访问时才会清理过期记录：伪造不同的
   * X-Forwarded-For、每个假 IP 只失败一次就换下一个，永远不会再被访问到，
   * 记录会无限堆积。每隔 sweepEvery 次失败做一次全量清扫堵住这个口子。
   */
  private sweepExpiredKeys(nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    for (const [key, hits] of this.perKey) {
      const active = hits.filter((t) => t > cutoff);
      if (active.length === 0) this.perKey.delete(key);
      else if (active.length !== hits.length) this.perKey.set(key, active);
    }
  }

  /** 当前维护的 key 数量；用于测试和监控内存增长 */
  size(): number {
    return this.perKey.size;
  }

  private activeHitsForKey(key: string, nowMs: number): number[] {
    const cutoff = nowMs - this.windowMs;
    const hits = (this.perKey.get(key) ?? []).filter((t) => t > cutoff);
    if (hits.length > 0) this.perKey.set(key, hits);
    else this.perKey.delete(key);
    return hits;
  }

  private activeGlobalHits(nowMs: number): number[] {
    const cutoff = nowMs - this.windowMs;
    this.global = this.global.filter((t) => t > cutoff);
    return this.global;
  }
}

/** 依次取 X-Forwarded-For 的第一段、X-Real-IP，都没有时返回 "unknown" */
export function clientKey(headers: Headers): string {
  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }

  const realIp = headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;

  return "unknown";
}
