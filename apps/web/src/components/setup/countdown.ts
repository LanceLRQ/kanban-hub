/** 配对码倒计时的纯函数部分：到期前给剩余秒数，到期（含恰好到期）后给 0 */
export function remainingSeconds(expiresAt: string, now: Date): number {
  const diffMs = Date.parse(expiresAt) - now.getTime();
  return Math.max(0, Math.ceil(diffMs / 1000));
}

/** “3:45” 这样的 mm:ss；不足 10 秒的秒数补零 */
export function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
