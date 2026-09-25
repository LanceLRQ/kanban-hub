"use client";

/**
 * `<LiveRefresh />` 维护的 SSE 连接状态，供顶栏的 `useLiveStatus()` 读取。用模块级的小型
 * 发布订阅（和 lib/preferences.ts 的 usePreferences 同一个模式），而不是 React context：
 * `<LiveRefresh />` 和读状态的组件都挂在 (app) 布局下，用 context 还要多包一层 Provider，
 * 模块级状态更直接，且天然只有一份（一次只应该有一条 SSE 连接）。
 */
export type LiveStatus = "connected" | "reconnecting" | "offline";

let status: LiveStatus = "connected";
const listeners = new Set<() => void>();

export function getLiveStatus(): LiveStatus {
  return status;
}

export function setLiveStatus(next: LiveStatus): void {
  if (next === status) return;
  status = next;
  for (const listener of listeners) listener();
}

export function subscribeLiveStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
