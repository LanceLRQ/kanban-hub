import { z } from "zod";
import type { Progress } from "@kanban-hub/core/derive";
import { CYCLES, HEALTHS, type Cycle, type Health } from "@kanban-hub/core/schema";

export const PROJECT_SORTS = ["activity", "created", "progress", "health"] as const;
export type ProjectSort = (typeof PROJECT_SORTS)[number];

export const PROGRESS_BUCKETS = ["all", "not_started", "in_progress", "done"] as const;
export type ProgressBucket = (typeof PROGRESS_BUCKETS)[number];

export interface ProjectsViewState {
  /** 空数组视同全部选中（含归档） */
  cycles: Cycle[];
  /** 空数组视同全部选中 */
  healths: Health[];
  progress: ProgressBucket;
  sort: ProjectSort;
  /** desc：最近、最高、最差的在前 */
  direction: "desc" | "asc";
}

export const DEFAULT_PROJECTS_VIEW: ProjectsViewState = {
  cycles: CYCLES.filter((cycle) => cycle !== "archived"),
  healths: [],
  progress: "all",
  sort: "activity",
  direction: "desc",
};

export const projectsViewStateSchema: z.ZodType<ProjectsViewState> = z.object({
  cycles: z.array(z.enum(CYCLES)),
  healths: z.array(z.enum(HEALTHS)),
  progress: z.enum(PROGRESS_BUCKETS),
  sort: z.enum(PROJECT_SORTS),
  direction: z.enum(["desc", "asc"]),
});

/** 参与筛选与排序的项目元数据 */
export interface ProjectFilterMeta {
  id: string;
  cycle: Cycle;
  health: Health;
  progress: Progress;
  createdAt: string;
  lastEventAt: string | null;
}

/** 健康度从差到好的次序 */
const HEALTH_RANK: Record<Health, number> = { blocked: 0, at_risk: 1, on_track: 2 };

/** 进度分档：没有任务或一个都没完成算未开始，全部完成算已完成，其余算进行中 */
export function progressBucket(progress: Progress): Exclude<ProgressBucket, "all"> {
  if (progress.total === 0 || progress.done === 0) return "not_started";
  return progress.done === progress.total ? "done" : "in_progress";
}

/** 多选值的实际选中集合：没选任何项与全选等价 */
export function effectiveSelection<T>(selected: readonly T[], all: readonly T[]): ReadonlySet<T> {
  return new Set(selected.length === 0 ? all : selected);
}

/** 周期是否与默认视图的选择一致（集合相等） */
function sameCycles(cycles: readonly Cycle[]): boolean {
  const current = effectiveSelection(cycles, CYCLES);
  const wanted = new Set<Cycle>(DEFAULT_PROJECTS_VIEW.cycles);
  return current.size === wanted.size && [...wanted].every((cycle) => current.has(cycle));
}

export function isDefaultProjectsView(state: ProjectsViewState): boolean {
  return (
    sameCycles(state.cycles) &&
    effectiveSelection(state.healths, HEALTHS).size === HEALTHS.length &&
    state.progress === "all" &&
    state.sort === "activity" &&
    state.direction === "desc"
  );
}

/** 没有事件的排在同组最后；`sign` 只决定有事件的那部分的先后 */
function compareActivity(a: ProjectFilterMeta, b: ProjectFilterMeta, sign: number): number {
  if (a.lastEventAt === null && b.lastEventAt === null) return 0;
  if (a.lastEventAt === null) return 1;
  if (b.lastEventAt === null) return -1;
  return sign * (Date.parse(b.lastEventAt) - Date.parse(a.lastEventAt));
}

function ratio(progress: Progress): number {
  return progress.total === 0 ? 0 : progress.done / progress.total;
}

/**
 * 先筛选再排序。归档项目不论哪种排序都整体排在最后，内部套用同一排序；
 * 进度、健康度排序在同一档内按最近活动倒序；排序稳定。
 */
export function applyProjectsView<T extends ProjectFilterMeta>(items: T[], state: ProjectsViewState): T[] {
  const cycles = effectiveSelection(state.cycles, CYCLES);
  const healths = effectiveSelection(state.healths, HEALTHS);
  const kept = items.filter(
    (item) =>
      cycles.has(item.cycle) &&
      healths.has(item.health) &&
      (state.progress === "all" || progressBucket(item.progress) === state.progress),
  );
  // desc 为 1 时 compare 的结果保持"高/新/差在前"
  const dir = state.direction === "desc" ? 1 : -1;
  const primary = (a: T, b: T): number => {
    switch (state.sort) {
      case "activity":
        return compareActivity(a, b, dir);
      case "created":
        return dir * (Date.parse(b.createdAt) - Date.parse(a.createdAt));
      case "progress":
        return dir * (ratio(b.progress) - ratio(a.progress)) || compareActivity(a, b, 1);
      case "health":
        return dir * (HEALTH_RANK[a.health] - HEALTH_RANK[b.health]) || compareActivity(a, b, 1);
    }
  };
  return [...kept].sort((a, b) => {
    const archivedA = a.cycle === "archived";
    const archivedB = b.cycle === "archived";
    if (archivedA !== archivedB) return archivedA ? 1 : -1;
    return primary(a, b);
  });
}
