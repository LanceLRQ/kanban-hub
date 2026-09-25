/**
 * 是否存在用户主动选择的筛选条件，用来在空列表时区分“还没有事件”和“没有符合条件的事件”
 * 两种空状态。
 *
 * 项目内时间线的 `filters.projectId` 是路由固定写入的（见 `parseTimelineFilters` 的
 * `fixedProjectId`），不是用户选的，判断时要排除掉，否则项目内时间线会永远判定为“筛选后为空”。
 */
import type { TimelineFilters } from "@/server/views/timeline";

export function hasActiveFilters(filters: TimelineFilters, fixedProjectId?: string): boolean {
  const projectFilterIsUserChosen = fixedProjectId === undefined && filters.projectId !== undefined;
  return projectFilterIsUserChosen || filters.group !== undefined || filters.actor !== undefined;
}
