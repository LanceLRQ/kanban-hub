/**
 * kh status 的两种输出：给人和 AI 看的短文本、给脚本用的 JSON。
 * 都只读 StatusView，不做 IO（buildStatusView 已经把所有推算做完了）。
 */
import type { ContainerStatus } from "@kanban-hub/core/derive";
import type { TaskStatus } from "@kanban-hub/core/schema";
import { CYCLE_LABELS, HEALTH_LABELS, HUMAN_KIND_LABELS, MANUAL_STATUS_LABELS, TASK_STATUS_LABELS } from "../commands/labels";
import { displayEmpty } from "../commands/shared";
import type { StatusView, StatusViewContainer, StatusViewTask } from "./view";

/** 任务状态符号（规格 5.3）；已取消没有符号，折叠计数里用文字 */
const TASK_STATUS_SYMBOLS: Partial<Record<TaskStatus, string>> = {
  todo: "⬜",
  in_progress: "🔶",
  review: "👀",
  done: "✅",
  suspended: "⏸",
};

/** 容器状态的中文名：todo/in_progress/done 复用任务状态文案，其余复用手动状态文案 */
const CONTAINER_STATUS_LABELS: Record<ContainerStatus, string> = {
  todo: TASK_STATUS_LABELS.todo,
  in_progress: TASK_STATUS_LABELS.in_progress,
  done: TASK_STATUS_LABELS.done,
  backlog: MANUAL_STATUS_LABELS.backlog,
  suspended: MANUAL_STATUS_LABELS.suspended,
  cancelled: MANUAL_STATUS_LABELS.cancelled,
};

/** 展开的容器：待开始、进行中，以及杂项（status 为 null） */
function isExpanded(status: ContainerStatus | null): boolean {
  return status === null || status === "todo" || status === "in_progress";
}

/** 未完成任务：待开始、进行中、复核中、挂起（已完成、已取消只计数，不逐条列出） */
function isOpenTask(status: TaskStatus): boolean {
  return status === "todo" || status === "in_progress" || status === "review" || status === "suspended";
}

/**
 * 任务的编号写法：有任务编号时展示成 "<容器标签>/<任务编号>"，容器标签用 containerRefLabel
 * 同一套规则（有编号用编号，杂项用 misc，否则用 ID 前缀），这样写出来的编号总能直接拿来引用
 * 这个任务；任务自己没有编号时省略。
 */
function taskCodeDisplay(task: StatusViewTask, container: StatusViewContainer): string | null {
  if (task.code === null) return null;
  return `${container.refLabel}/${task.code}`;
}

/**
 * 时间戳只取日期部分（YYYY-MM-DD），折叠摘要里不需要时分秒。按本机时区取日期而不是直接
 * 截取 UTC 字符串：UTC 晚上的时间戳在本机时区可能已经是第二天。时区可以注入（测试用），
 * 默认取 Intl 解析出的本机时区。
 */
export function formatDateOnly(isoTimestamp: string, timeZone: string = defaultTimeZone()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(isoTimestamp),
  );
}

function defaultTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function renderTaskLine(task: StatusViewTask, container: StatusViewContainer): string {
  const symbol = TASK_STATUS_SYMBOLS[task.status] ?? "";
  const codeDisplay = taskCodeDisplay(task, container);
  const parts = [symbol, task.ref, codeDisplay, task.title].filter((v): v is string => v !== null && v !== "");
  if (task.group) parts.push(`[${task.group}]`);
  if (task.dueDate) parts.push(`截止 ${task.dueDate}`);
  if (task.checklist.total > 0) parts.push(`清单 ${task.checklist.done}/${task.checklist.total}`);
  if (task.status === "suspended" && task.suspendReason) parts.push(`原因：${task.suspendReason}`);
  return parts.join(" ");
}

function renderContainerHeader(container: StatusViewContainer): string {
  const codePrefix = container.code ? `[${container.code}] ` : "";

  if (container.status === null) {
    // 杂项容器不参与状态推算，规格 5.4：只显示未完成任务的数量，不显示完成度分数
    return `${codePrefix}${container.title}（${container.openCount} 个未完成）`;
  }

  if (isExpanded(container.status)) {
    const statusLabel = CONTAINER_STATUS_LABELS[container.status];
    return `${codePrefix}${container.title} ${statusLabel}（${container.progress.done}/${container.progress.total}）`;
  }

  // 折叠：已完成 / 已取消 / 储备 / 挂起。任务数不计已取消的，有已取消的话另注一句
  const status = container.status as ContainerStatus;
  const statusLabel = CONTAINER_STATUS_LABELS[status];
  const cancelledCount = container.tasks.filter((t) => t.status === "cancelled").length;
  const activeCount = container.tasks.length - cancelledCount;
  const extras: string[] = [];
  if (status === "done" && container.doneAt) extras.push(`完成于 ${formatDateOnly(container.doneAt)}`);
  if (status === "suspended" && container.manualReason) extras.push(`原因：${container.manualReason}`);
  if (cancelledCount > 0) extras.push(`另有 ${cancelledCount} 个已取消`);
  const extra = extras.length > 0 ? `，${extras.join("，")}` : "";
  return `${codePrefix}${container.title} ${statusLabel}（共 ${activeCount} 个任务${extra}）`;
}

function renderContainer(container: StatusViewContainer): string[] {
  const lines = [renderContainerHeader(container)];
  if (!isExpanded(container.status)) return lines;

  const openTasks = container.tasks.filter((t) => isOpenTask(t.status));
  for (const task of openTasks) lines.push(`  ${renderTaskLine(task, container)}`);

  const doneCount = container.tasks.filter((t) => t.status === "done").length;
  const cancelledCount = container.tasks.filter((t) => t.status === "cancelled").length;
  const summaryParts: string[] = [];
  if (doneCount > 0) summaryParts.push(`已完成 ${doneCount} 个`);
  if (cancelledCount > 0) summaryParts.push(`已取消 ${cancelledCount} 个`);
  if (summaryParts.length > 0) lines.push(`  ${summaryParts.join("，")}`);

  return lines;
}

/** 给人和 AI 看的短文本：目标是一眼读懂，不是完整转储（已完成/已取消的容器和任务都会折叠） */
export function renderStatusText(view: StatusView): string {
  const lines: string[] = [];
  const p = view.project;

  lines.push(`${p.name} · ${CYCLE_LABELS[p.cycle]} · ${HEALTH_LABELS[p.health]} · 进度 ${p.progress.done}/${p.progress.total}`);
  lines.push(`焦点：${displayEmpty(p.focus)}`);
  if (p.stale) lines.push(`停滞 ${p.idleDays} 天`);
  if (view.location) {
    const syncPart = view.location.lastSyncAt ? `，上次同步 ${view.location.lastSyncAt}` : "，尚未同步";
    lines.push(`本机位置：${view.location.path}${syncPart}`);
  }

  if (view.inbox.length > 0) {
    lines.push("");
    lines.push("待你处理：");
    for (const item of view.inbox) {
      lines.push(`  ${item.ref} ${HUMAN_KIND_LABELS[item.kind]} ${item.note} — ${item.taskTitle}`);
    }
  }

  for (const container of view.containers) {
    lines.push("");
    lines.push(...renderContainer(container));
  }

  return `${lines.join("\n")}\n`;
}

/** 给脚本和 M6 用的 JSON：整个 view 原样输出，包含全部任务，不折叠 */
export function toStatusJson(view: StatusView): unknown {
  return view;
}
