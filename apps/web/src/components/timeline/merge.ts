/**
 * 客户端合并时间线的天分组，按事件 ID 去重。
 *
 * - `incomingFirst = false`：追加更早的一页（“加载更多”）。同一天已有的事件排在前面，
 *   新取到的事件接在后面——分页天然是从新到旧续取，新事件总是更早，理应排在后面。
 * - `incomingFirst = true`：合并刷新后的首页（SSE 刷新）。新页代表“头部”的最新状态，
 *   其中没见过的事件排在前面；已知事件的内容（标题、状态等可能已经改变）和当天的标题
 *   都以刷新结果为准，保持和服务端最新数据一致。
 *
 * 两种模式都只新增、不删除：`prev` 里存在、但不在 `incoming` 里的天数（例如已经“加载更多”
 * 出来的更早的天，不会出现在刷新后的首页里）原样保留，不会被刷新丢弃。
 */
import type { EventCursor } from "@kanban-hub/core/api";
import type { TimelineDay, TimelinePage } from "@/server/views/timeline";

export function mergeTimelineDays(prev: readonly TimelineDay[], incoming: readonly TimelineDay[], incomingFirst: boolean): TimelineDay[] {
  const byKey = new Map(prev.map((day) => [day.key, day]));

  for (const day of incoming) {
    const existing = byKey.get(day.key);
    if (!existing) {
      byKey.set(day.key, day);
      continue;
    }

    if (incomingFirst) {
      const incomingById = new Map(day.items.map((i) => [i.id, i]));
      const existingIds = new Set(existing.items.map((i) => i.id));
      const newItems = day.items.filter((i) => !existingIds.has(i.id));
      const refreshedExisting = existing.items.map((i) => incomingById.get(i.id) ?? i);
      byKey.set(day.key, { ...day, items: [...newItems, ...refreshedExisting] });
      continue;
    }

    const knownIds = new Set(existing.items.map((i) => i.id));
    const newItems = day.items.filter((i) => !knownIds.has(i.id));
    byKey.set(day.key, { ...existing, items: [...existing.items, ...newItems] });
  }

  return [...byKey.values()].sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
}

export interface TimelineRefreshState {
  days: readonly TimelineDay[];
  cursor: EventCursor | null;
  /** 是否已经点过“加载更多”，也就是分页游标不再等于首页游标 */
  loadedMore: boolean;
}

/**
 * SSE 刷新时把新首页并入已加载的状态，同时决定分页游标怎么处理：
 * - 还没“加载更多”过：直接合并，游标跟着换成新首页的游标；
 * - 已经“加载更多”过：合并内容，但游标保持不变——否则“加载更多”会重新取到已经加载过的页，
 *   全部加载完时按钮还会因为游标被换回非空值而重新出现；
 * - 已加载的内容非空，且新首页和已加载的事件 ID 完全不重叠（说明中间新增的事件超过了一页，
 *   出现了断层，合并已经没有意义）：直接用新页整体替换，游标和“加载更多”状态都重置。
 */
export function reconcileRefresh(prev: TimelineRefreshState, page: TimelinePage): TimelineRefreshState {
  const prevIds = new Set(prev.days.flatMap((day) => day.items.map((item) => item.id)));

  if (prevIds.size > 0) {
    const incomingIds = page.days.flatMap((day) => day.items.map((item) => item.id));
    const hasOverlap = incomingIds.some((id) => prevIds.has(id));
    if (!hasOverlap) {
      return { days: page.days, cursor: page.nextCursor, loadedMore: false };
    }
  }

  const days = mergeTimelineDays(prev.days, page.days, true);
  return { days, cursor: prev.loadedMore ? prev.cursor : page.nextCursor, loadedMore: prev.loadedMore };
}
