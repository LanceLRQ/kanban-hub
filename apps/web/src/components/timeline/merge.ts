/**
 * 客户端合并时间线的天分组，按事件 ID 去重（细节「SSE 刷新」「加载更多」）。
 *
 * - `incomingFirst = false`：追加更早的一页（“加载更多”）。同一天已有的事件排在前面，
 *   新取到的事件接在后面——分页天然是从新到旧续取，新事件总是更早，理应排在后面。
 * - `incomingFirst = true`：合并刷新后的首页（SSE 刷新）。新页代表“头部”的最新状态，
 *   其中没见过的事件是比已知事件更新的，排在前面；已知事件不变。
 *
 * 两种模式都只新增、不删除：`prev` 里存在、但不在 `incoming` 里的天数（例如已经“加载更多”
 * 出来的更早的天，不会出现在刷新后的首页里）原样保留，不会被刷新丢弃。
 */
import type { TimelineDay } from "@/server/views/timeline";

export function mergeTimelineDays(prev: readonly TimelineDay[], incoming: readonly TimelineDay[], incomingFirst: boolean): TimelineDay[] {
  const byKey = new Map(prev.map((day) => [day.key, day]));

  for (const day of incoming) {
    const existing = byKey.get(day.key);
    if (!existing) {
      byKey.set(day.key, day);
      continue;
    }
    const knownIds = new Set(existing.items.map((i) => i.id));
    const newItems = day.items.filter((i) => !knownIds.has(i.id));
    const items = incomingFirst ? [...newItems, ...existing.items] : [...existing.items, ...newItems];
    byKey.set(day.key, { ...existing, items });
  }

  return [...byKey.values()].sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
}
