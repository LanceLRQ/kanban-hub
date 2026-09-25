import type { Board, Container, Project, Task } from "./schema";

/** 容器的显示状态：推算出的 todo / in_progress / done，或者手动设置的状态 */
export type ContainerStatus = "todo" | "in_progress" | "done" | "backlog" | "suspended" | "cancelled";

/** 完成度：total 不含已取消的任务 */
export interface Progress {
  done: number;
  total: number;
}

export interface ContainerSummary {
  /** 杂项容器不参与推算，为 null */
  status: ContainerStatus | null;
  startedAt: string | null;
  completedAt: string | null;
  progress: Progress;
  /** 未完成（既不是已完成也不是已取消）的任务数；杂项容器只显示这一项 */
  openCount: number;
}

/** 停滞判定的默认天数（规格 5.5） */
export const DEFAULT_STALE_DAYS = 7;

const DAY_MS = 86_400_000;

/** 进度：已完成数 ÷（总数 − 已取消数）（规格 5.4） */
export function progressOf(tasks: readonly Pick<Task, "status">[]): Progress {
  const counted = tasks.filter((t) => t.status !== "cancelled");
  return { done: counted.filter((t) => t.status === "done").length, total: counted.length };
}

/** 任务清单的完成度 */
export function checklistProgress(items: readonly { done: boolean }[]): Progress {
  return { done: items.filter((i) => i.done).length, total: items.length };
}

/**
 * 项目整体进度（规格 5.4）：只统计阶段和特性容器里的任务，不含杂项容器；
 * 已取消的任务不计入分子分母（复用 progressOf）。杂项容器是随手记的东西，不是计划内的工作量。
 */
export function projectProgress(board: Pick<Board, "containers" | "tasks">): Progress {
  const miscContainerId = board.containers.find((c) => c.kind === "misc")?.id;
  const trackedTasks = board.tasks.filter((t) => t.containerId !== miscContainerId);
  return progressOf(trackedTasks);
}

/**
 * 容器状态（规格 5.4，按顺序判断，命中即停）：
 * 1. 有手动状态就用它；
 * 2. 排除已取消的任务后，没有任务或全部是 todo，为待开始；
 * 3. 排除已取消的任务后，全部是 done（至少一个），为已完成；
 * 4. 其余为进行中。
 * 杂项容器不参与推算。
 */
export function containerStatus(
  container: Pick<Container, "kind" | "manualStatus">,
  tasks: readonly Pick<Task, "status">[],
): ContainerStatus | null {
  if (container.kind === "misc") return null;
  if (container.manualStatus !== null) return container.manualStatus;
  const active = tasks.filter((t) => t.status !== "cancelled");
  if (active.every((t) => t.status === "todo")) return "todo";
  if (active.every((t) => t.status === "done")) return "done";
  return "in_progress";
}

/** 汇总一个容器：状态、日期、进度。tasks 可以传整个看板的任务，这里按 containerId 筛选 */
export function summarizeContainer(container: Container, tasks: readonly Task[]): ContainerSummary {
  const own = tasks.filter((t) => t.containerId === container.id);
  const status = containerStatus(container, own);
  return {
    status,
    // 开始日期是任务 startedAt 的最小值；容器已完成时，完成日期是任务 completedAt 的最大值
    startedAt: container.kind === "misc" ? null : pick(own.map((t) => t.startedAt), (a, b) => a < b),
    completedAt: status === "done" ? pick(own.map((t) => t.completedAt), (a, b) => a > b) : null,
    progress: progressOf(own),
    openCount: own.filter((t) => t.status !== "done" && t.status !== "cancelled").length,
  };
}

/** 停滞：最近一条事件距今超过 staleDays 天，且周期不是归档（规格 5.5）。没有事件时按项目创建时间算 */
export function isStale(
  project: Pick<Project, "cycle" | "createdAt">,
  lastEventAt: string | null,
  now: Date,
  staleDays: number = DEFAULT_STALE_DAYS,
): boolean {
  if (project.cycle === "archived") return false;
  return now.getTime() - Date.parse(lastEventAt ?? project.createdAt) > staleDays * DAY_MS;
}

/** 解析 KH_STALE_DAYS；不是正整数时用默认值 */
export function parseStaleDays(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_STALE_DAYS;
}

/** 从一组时间里挑一个（最早或最晚），比较用时间戳而不是字符串 */
function pick(values: readonly (string | null)[], better: (a: number, b: number) => boolean): string | null {
  let best: string | null = null;
  for (const v of values) {
    if (v !== null && (best === null || better(Date.parse(v), Date.parse(best)))) best = v;
  }
  return best;
}
