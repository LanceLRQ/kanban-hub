/**
 * SSE 断线重连的退避秒数：1、2、4、8……上限 30 秒，成功重连后由调用方重置为 0 再次调用。
 * `previousSeconds` 传 0（或负数）表示这是断线后的第一次重试。
 */
const BACKOFF_MAX_SECONDS = 30;

export function nextBackoffSeconds(previousSeconds: number): number {
  if (previousSeconds <= 0) return 1;
  return Math.min(previousSeconds * 2, BACKOFF_MAX_SECONDS);
}
