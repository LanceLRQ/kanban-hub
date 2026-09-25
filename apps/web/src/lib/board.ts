/**
 * 项目看板的显示口径（纯函数）：容器分区的顺序与折叠、任务行右侧的信息。
 * 日期按调用方传入的时区格式化（页面里是服务端时区），不读全局时钟。
 */
import { checklistProgress, summarizeContainer, type ContainerSummary } from "@kanban-hub/core/derive";
import type { Board, Container, Task } from "@kanban-hub/core/schema";
import { dayKey, formatDate, formatPlainDate } from "./time";

export interface Section {
  container: Container;
  summary: ContainerSummary;
  /** 推算状态为已完成的容器默认折叠成一行摘要 */
  collapsed: boolean;
  /** 本容器的全部任务（含已取消），按 order 排列 */
  tasks: Task[];
  /** 已取消的任务数：折叠摘要里的任务数不计它们，另外注明 */
  cancelledCount: number;
}

/** 分区的大类：阶段 / 特性（储备的除外）→ 储备 → 杂项 */
function sectionRank(container: Pick<Container, "kind" | "manualStatus">): number {
  if (container.kind === "misc") return 2;
  if (container.manualStatus === "backlog") return 1;
  return 0;
}

function byOrder(a: { order: number; createdAt: string; id: string }, b: { order: number; createdAt: string; id: string }): number {
  return a.order - b.order || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

/**
 * 看板分区：阶段和特性按 order 排列（储备的除外）→ 储备的容器 → 杂项容器。
 * 挂起、已取消的容器留在原位，只是状态不同。
 */
export function boardSections(board: Pick<Board, "containers" | "tasks">): Section[] {
  const containers = [...board.containers].sort((a, b) => sectionRank(a) - sectionRank(b) || byOrder(a, b));
  return containers.map((container) => {
    const tasks = board.tasks.filter((task) => task.containerId === container.id).sort(byOrder);
    const summary = summarizeContainer(container, tasks);
    return {
      container,
      summary,
      collapsed: summary.status === "done",
      tasks,
      cancelledCount: tasks.filter((task) => task.status === "cancelled").length,
    };
  });
}

/** 任务行右侧的主信息，按优先级取一项 */
export type TaskMetaMain =
  | { kind: "completed"; date: string }
  | { kind: "due"; date: string }
  | { kind: "startedToday" }
  | { kind: "started"; date: string }
  | { kind: "checklist"; done: number; total: number };

export interface TaskMeta {
  main: TaskMetaMain | null;
  /** 备注的第一行非空文字，显示在主信息前面 */
  note: string | null;
  group: string | null;
  docRefs: string[];
}

type TaskMetaInput = Pick<Task, "status" | "completedAt" | "dueDate" | "startedAt" | "checklist" | "note" | "group" | "docRefs">;

/**
 * 任务行右侧的信息。主信息的优先级：
 * 1. 已完成：完成于 M 月 D 日；
 * 2. 有截止日期：截止 M 月 D 日；
 * 3. 进行中：开始于 M 月 D 日（当天写“开始于今天”）；
 * 4. 有清单：清单 a/b。
 */
export function taskMeta(task: TaskMetaInput, now: Date, tz: string): TaskMeta {
  return {
    main: mainMeta(task, now, tz),
    note: firstLine(task.note),
    group: task.group,
    docRefs: [...task.docRefs],
  };
}

function mainMeta(task: TaskMetaInput, now: Date, tz: string): TaskMetaMain | null {
  if (task.status === "done" && task.completedAt !== null) return { kind: "completed", date: formatDate(task.completedAt, tz, now) };
  if (task.dueDate !== null) return { kind: "due", date: formatPlainDate(task.dueDate, tz, now) };
  if (task.status === "in_progress" && task.startedAt !== null) {
    return dayKey(task.startedAt, tz) === dayKey(now, tz) ? { kind: "startedToday" } : { kind: "started", date: formatDate(task.startedAt, tz, now) };
  }
  if (task.checklist.length > 0) return { kind: "checklist", ...checklistProgress(task.checklist) };
  return null;
}

function firstLine(text: string): string | null {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  return line ?? null;
}
