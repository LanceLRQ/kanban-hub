import { z } from "zod";
import type { TaskStatus } from "@kanban-hub/core/schema";
import type { BoardTaskView } from "@/server/views/board";

export const BOARD_SORTS = ["manual", "updated", "created", "status"] as const;
export type BoardSort = (typeof BOARD_SORTS)[number];

/** 状态下拉里的 7 项：任务状态加上只属于里程碑的储备（复核中只属于任务） */
export const BOARD_STATUS_OPTIONS = ["todo", "in_progress", "review", "done", "backlog", "suspended", "cancelled"] as const;
export type BoardStatusOption = (typeof BOARD_STATUS_OPTIONS)[number];

/** 状态筛选作用的对象：只筛里程碑 / 只筛任务行 / 两层都筛 */
export const BOARD_FILTER_MODES = ["milestone", "task", "both"] as const;
export type BoardFilterMode = (typeof BOARD_FILTER_MODES)[number];

export interface BoardViewState {
  /** 空数组视同全部选中 */
  statuses: BoardStatusOption[];
  filterMode: BoardFilterMode;
  humanOnly: boolean;
  sort: BoardSort;
  /** 只对按时间排序生效：desc 新的在前 */
  direction: "desc" | "asc";
}

export const DEFAULT_BOARD_VIEW: BoardViewState = { statuses: [], filterMode: "milestone", humanOnly: false, sort: "manual", direction: "desc" };

/** filterMode 缺省取 milestone，旧的本地存值（只有任务状态）因此仍能解析 */
export const boardViewStateSchema: z.ZodType<BoardViewState> = z.object({
  statuses: z.array(z.enum(BOARD_STATUS_OPTIONS)),
  filterMode: z.enum(BOARD_FILTER_MODES).default("milestone"),
  humanOnly: z.boolean(),
  sort: z.enum(BOARD_SORTS),
  direction: z.enum(["desc", "asc"]),
});

/** 按状态排序的先后：进行中 → 复核中 → 待开始 → 挂起 → 已完成 → 已取消 */
const STATUS_RANK: Record<TaskStatus, number> = { in_progress: 0, review: 1, todo: 2, suspended: 3, done: 4, cancelled: 5 };

/** 是否在筛选；没选任何状态与全选等价 */
export function isStatusFilterActive(statuses: readonly BoardStatusOption[]): boolean {
  return statuses.length > 0 && new Set(statuses).size < BOARD_STATUS_OPTIONS.length;
}

/** 里程碑维度的有效状态集合：筛选方式含里程碑，且所选项里有里程碑状态（去掉复核中）；否则 null 表示不筛 */
function milestoneStatuses(state: BoardViewState): Set<string> | null {
  if (state.filterMode === "task" || !isStatusFilterActive(state.statuses)) return null;
  const set = new Set<string>(state.statuses.filter((s) => s !== "review"));
  return set.size === 0 ? null : set;
}

/** 任务维度的有效状态集合：筛选方式含任务，且所选项里有任务状态（去掉储备）；否则 null 表示不筛 */
function taskStatuses(state: BoardViewState): Set<string> | null {
  if (state.filterMode === "milestone" || !isStatusFilterActive(state.statuses)) return null;
  const set = new Set<string>(state.statuses.filter((s) => s !== "backlog"));
  return set.size === 0 ? null : set;
}

/** 里程碑分区是否显示；杂项（没有状态）始终显示 */
export function sectionVisible(section: { status: BoardStatusOption | null }, state: BoardViewState): boolean {
  const wanted = milestoneStatuses(state);
  return wanted === null || section.status === null || wanted.has(section.status);
}

/** 工具栏上的“重置”要不要出现：任一项偏离默认；没选状态时，筛选方式不起作用 */
export function isDefaultBoardView(state: BoardViewState): boolean {
  return !isStatusFilterActive(state.statuses) && !state.humanOnly && state.sort === "manual";
}

/** 任务行是否没被筛选或重排：决定“新建任务”输入框是否显示（只按里程碑筛选时仍显示） */
export function tasksUnfiltered(state: BoardViewState): boolean {
  return taskStatuses(state) === null && !state.humanOnly && state.sort === "manual";
}

/** 先筛选再排序；排序稳定，相同的值保持传入数组的顺序（即手动顺序） */
export function applyBoardView(tasks: BoardTaskView[], state: BoardViewState): BoardTaskView[] {
  const wanted = taskStatuses(state);
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
