import { z } from "zod";
import { TASK_STATUSES, type TaskStatus } from "@kanban-hub/core/schema";
import type { BoardTaskView } from "@/server/views/board";

export const BOARD_SORTS = ["manual", "updated", "created", "status"] as const;
export type BoardSort = (typeof BOARD_SORTS)[number];

export interface BoardViewState {
  /** 空数组视同全部选中 */
  statuses: TaskStatus[];
  humanOnly: boolean;
  sort: BoardSort;
  /** 只对按时间排序生效：desc 新的在前 */
  direction: "desc" | "asc";
}

export const DEFAULT_BOARD_VIEW: BoardViewState = { statuses: [], humanOnly: false, sort: "manual", direction: "desc" };

export const boardViewStateSchema: z.ZodType<BoardViewState> = z.object({
  statuses: z.array(z.enum(TASK_STATUSES)),
  humanOnly: z.boolean(),
  sort: z.enum(BOARD_SORTS),
  direction: z.enum(["desc", "asc"]),
});

/** 按状态排序的先后：进行中 → 复核中 → 待开始 → 挂起 → 已完成 → 已取消 */
const STATUS_RANK: Record<TaskStatus, number> = { in_progress: 0, review: 1, todo: 2, suspended: 3, done: 4, cancelled: 5 };

/** 是否在筛选；没选任何状态与全选等价 */
export function isStatusFilterActive(statuses: readonly TaskStatus[]): boolean {
  return statuses.length > 0 && new Set(statuses).size < TASK_STATUSES.length;
}

export function isDefaultBoardView(state: BoardViewState): boolean {
  return !isStatusFilterActive(state.statuses) && !state.humanOnly && state.sort === "manual";
}

/** 先筛选再排序；排序稳定，相同的值保持传入数组的顺序（即手动顺序） */
export function applyBoardView(tasks: BoardTaskView[], state: BoardViewState): BoardTaskView[] {
  const wanted = isStatusFilterActive(state.statuses) ? new Set(state.statuses) : null;
  const kept = tasks.filter((task) => (wanted === null || wanted.has(task.status)) && (!state.humanOnly || task.human !== null));
  const sign = state.direction === "desc" ? -1 : 1;
  const compare: ((a: BoardTaskView, b: BoardTaskView) => number) | null =
    state.sort === "status"
      ? (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]
      : state.sort === "updated"
        ? (a, b) => sign * (Date.parse(a.updatedAt) - Date.parse(b.updatedAt))
        : state.sort === "created"
          ? (a, b) => sign * (Date.parse(a.createdAt) - Date.parse(b.createdAt))
          : null;
  // Array.prototype.sort 保证稳定
  return compare === null ? kept : [...kept].sort(compare);
}
