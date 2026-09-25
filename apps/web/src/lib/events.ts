/**
 * 事件的分组、显示排序、结构化描述。
 * 总览的“最近活动”和时间线共用 describeEvent 产出的描述：组件用 t(key, values) 渲染，
 * 消息文本在 messages/zh-CN/events.json 里。events.json 是嵌套结构，key 用点号分隔的路径
 * （例如 "task.updated.title"），与 next-intl 按命名空间嵌套解析 key 的方式对应。
 *
 * 事件描述里用到的枚举中文名（周期、健康度、任务状态、待你处理、容器手动状态）来自 next-intl
 * 的 enums 命名空间，不在这里另外维护一份：调用方（服务端视图）用 enums.json 构造 enumLabel
 * 传进 ctx，这里只按分组名 + 取值转发过去。
 */
import type { Board, ChecklistItem, Event, EventType, HumanFlag, ManualStatus, TaskStatus } from "@kanban-hub/core/schema";
import { containerRefLabel, taskShortRef } from "./refs";

// ---------- 分组（用于类型筛选） ----------

export const EVENT_GROUPS = {
  task: ["task.created", "task.updated", "task.status_changed", "task.human_changed"],
  container: ["container.created", "container.updated"],
  project: ["project.created", "project.updated"],
  log: ["log"],
  docs: ["docs.synced", "docs.pulled"],
  import: ["import.applied"],
} as const satisfies Record<string, readonly EventType[]>;

export type EventGroup = keyof typeof EVENT_GROUPS;

const TYPE_TO_GROUP = new Map<EventType, EventGroup>(
  (Object.entries(EVENT_GROUPS) as [EventGroup, readonly EventType[]][]).flatMap(([group, types]) =>
    types.map((type) => [type, group] as const),
  ),
);

export function eventGroupOf(type: EventType): EventGroup {
  const group = TYPE_TO_GROUP.get(type);
  if (group === undefined) throw new Error(`未知的事件类型：${type}`);
  return group;
}

// ---------- 显示排序 ----------

/**
 * 同一时刻的多条事件按固定的次级顺序排：*.created → *.updated → task.status_changed →
 * task.human_changed → 其他。数值越大，排序越靠前（配合下面的降序比较）。
 */
function secondaryOrder(type: EventType): number {
  if (type.endsWith(".created")) return 4;
  if (type.endsWith(".updated")) return 3;
  if (type === "task.status_changed") return 2;
  if (type === "task.human_changed") return 1;
  return 0;
}

/** 按 (ts, 次级顺序, id) 三个键整体倒序：最新的在前，同一时刻按次级顺序，再靠 id 兜底 */
export function sortEventsForDisplay(events: readonly Event[]): Event[] {
  return [...events].sort((a, b) => {
    const byTs = Date.parse(b.ts) - Date.parse(a.ts);
    if (byTs !== 0) return byTs;
    const byOrder = secondaryOrder(b.type) - secondaryOrder(a.type);
    if (byOrder !== 0) return byOrder;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

// ---------- 描述 ----------

/** enums.json 里，事件描述会用到的分组（对应 cycle / health / taskStatus / humanKind / manualStatus） */
export type EnumLabelGroup = "cycle" | "health" | "taskStatus" | "humanKind" | "manualStatus";

/** 按分组取枚举值的中文名，由调用方用 next-intl 的 enums 命名空间构造 */
export type EnumLabelFn = (group: EnumLabelGroup, value: string) => string;

export interface EventDescribeCtx {
  board: Pick<Board, "containers" | "tasks">;
  projectName: string;
  enumLabel: EnumLabelFn;
  /** 字段被清空时的占位文案（events.json 的 common.none），不在这里硬编码 */
  noneLabel: string;
}

export interface EventDescription {
  /** events 命名空间里的消息键，组件用 t(key, values) 渲染 */
  key: string;
  values: Record<string, string | number>;
}

type FieldChange = { from?: unknown; to?: unknown };
type Change = Record<string, FieldChange>;

/** 任务在描述里的显示：短引用 + 标题；任务在看板里已经找不到时，用 ID 前缀兜底，不抛错 */
function taskLabel(board: EventDescribeCtx["board"], taskId: string): string {
  const task = board.tasks.find((t) => t.id === taskId);
  if (!task) return `#${taskId.slice(0, 4)}`;
  return `${taskShortRef(board, taskId)} ${task.title}`;
}

/** 容器在描述里的显示：引用标签 + 标题；容器在看板里已经找不到时，用 ID 前缀兜底，不抛错 */
function containerLabel(board: EventDescribeCtx["board"], containerId: string): string {
  const container = board.containers.find((c) => c.id === containerId);
  if (!container) return containerId.slice(0, 4);
  return `${containerRefLabel(container, board.containers)} ${container.title}`;
}

/** 兜底描述：常见字段之外的其余字段，取变化里的第一个字段名 */
function genericChange(key: string, change: Change, extra: Record<string, string | number>): EventDescription {
  const field = Object.keys(change)[0] ?? "";
  return { key, values: { ...extra, field } };
}

function describeProjectUpdated(event: Event, ctx: EventDescribeCtx): EventDescription {
  const change = (event.change ?? {}) as Change;
  if ("cycle" in change) return { key: "project.updated.cycle", values: { cycle: ctx.enumLabel("cycle", String(change.cycle!.to)) } };
  if ("health" in change) return { key: "project.updated.health", values: { health: ctx.enumLabel("health", String(change.health!.to)) } };
  if ("focus" in change) return { key: "project.updated.focus", values: { focus: String(change.focus!.to ?? "") } };
  if ("name" in change) return { key: "project.updated.name", values: { name: String(change.name!.to ?? "") } };
  return genericChange("project.updated.generic", change, {});
}

function describeContainerUpdated(event: Event, ctx: EventDescribeCtx): EventDescription {
  const change = (event.change ?? {}) as Change;
  const container = containerLabel(ctx.board, event.target?.containerId ?? "");
  if ("manualStatus" in change) {
    const to = change.manualStatus!.to as ManualStatus | null;
    if (to === null) return { key: "container.updated.manualStatusCleared", values: { container } };
    return { key: "container.updated.manualStatus", values: { container, status: ctx.enumLabel("manualStatus", to) } };
  }
  if ("targetVersion" in change) {
    return { key: "container.updated.targetVersion", values: { container, version: String(change.targetVersion!.to ?? ctx.noneLabel) } };
  }
  if ("targetDate" in change) {
    return { key: "container.updated.targetDate", values: { container, date: String(change.targetDate!.to ?? ctx.noneLabel) } };
  }
  if ("title" in change) return { key: "container.updated.title", values: { container, title: String(change.title!.to ?? "") } };
  return genericChange("container.updated.generic", change, { container });
}

function describeTaskUpdated(event: Event, ctx: EventDescribeCtx): EventDescription {
  const change = (event.change ?? {}) as Change;
  const task = taskLabel(ctx.board, event.target?.taskId ?? "");
  if ("checklist" in change) {
    const items = (change.checklist!.to as ChecklistItem[] | undefined) ?? [];
    const done = items.filter((i) => i.done).length;
    return { key: "task.updated.checklist", values: { task, done, total: items.length } };
  }
  if ("title" in change) return { key: "task.updated.title", values: { task, title: String(change.title!.to ?? "") } };
  if ("group" in change) return { key: "task.updated.group", values: { task, group: String(change.group!.to ?? ctx.noneLabel) } };
  if ("dueDate" in change) return { key: "task.updated.dueDate", values: { task, date: String(change.dueDate!.to ?? ctx.noneLabel) } };
  if ("note" in change) return { key: "task.updated.note", values: { task } };
  return genericChange("task.updated.generic", change, { task });
}

function describeTaskStatusChanged(event: Event, ctx: EventDescribeCtx): EventDescription {
  const task = taskLabel(ctx.board, event.target?.taskId ?? "");
  const to: TaskStatus = (event.change?.status?.to as TaskStatus | undefined) ?? "todo";
  return { key: "task.statusChanged", values: { task, status: ctx.enumLabel("taskStatus", to) } };
}

function describeTaskHumanChanged(event: Event, ctx: EventDescribeCtx): EventDescription {
  const task = taskLabel(ctx.board, event.target?.taskId ?? "");
  const to = event.change?.human?.to as HumanFlag | null | undefined;
  if (to == null) return { key: "task.human.cleared", values: { task } };
  return { key: "task.human.changed", values: { task, kind: ctx.enumLabel("humanKind", to.kind), note: to.note } };
}

/**
 * 事件的结构化描述：{ key, values }，key 是 events 命名空间里的消息键。
 * 任务或容器在看板里已经找不到时，用事件本身的 ID 前缀兜底，不抛错（见 taskLabel / containerLabel）。
 */
export function describeEvent(event: Event, ctx: EventDescribeCtx): EventDescription {
  switch (event.type) {
    case "project.created":
      return { key: "project.created", values: { project: ctx.projectName } };
    case "project.updated":
      return describeProjectUpdated(event, ctx);
    case "container.created":
      return { key: "container.created", values: { container: containerLabel(ctx.board, event.target?.containerId ?? "") } };
    case "container.updated":
      return describeContainerUpdated(event, ctx);
    case "task.created":
      return { key: "task.created", values: { task: taskLabel(ctx.board, event.target?.taskId ?? "") } };
    case "task.updated":
      return describeTaskUpdated(event, ctx);
    case "task.status_changed":
      return describeTaskStatusChanged(event, ctx);
    case "task.human_changed":
      return describeTaskHumanChanged(event, ctx);
    case "log":
      return { key: "log", values: { text: event.text ?? "" } };
    case "docs.synced":
      return { key: "docs.synced", values: {} };
    case "docs.pulled":
      return { key: "docs.pulled", values: {} };
    case "import.applied":
      return { key: "import.applied", values: {} };
  }
}
