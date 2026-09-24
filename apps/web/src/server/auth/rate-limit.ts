/** 每个 key 在窗口内允许的失败次数 */
const DEFAULT_PER_KEY_LIMIT = 5;
/** 所有 key 加在一起、窗口内允许的失败次数 */
const DEFAULT_GLOBAL_LIMIT = 30;
/** 滑动窗口长度 */
const DEFAULT_WINDOW_MS = 60_000;

export type FailureCheckResult = { blocked: false } | { blocked: true; retryAfterSec: number };

/** 基于滑动窗口的失败次数限流：只统计失败，成功不清零，窗口过去后自动恢复 */
export class FailureLimiter {
  private readonly now: () => Date;
  private readonly perKeyLimit: number;
  private readonly globalLimit: number;
  private readonly windowMs: number;
  /** 每个 key 的失败时间戳（毫秒），按时间升序 */
  private readonly perKey = new Map<string, number[]>();
  /** 全部 key 加在一起的失败时间戳，按时间升序 */
  private global: number[] = [];

  constructor(opts: { now: () => Date; perKeyLimit?: number; globalLimit?: number; windowMs?: number }) {
    this.now = opts.now;
    this.perKeyLimit = opts.perKeyLimit ?? DEFAULT_PER_KEY_LIMIT;
    this.globalLimit = opts.globalLimit ?? DEFAULT_GLOBAL_LIMIT;
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
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
