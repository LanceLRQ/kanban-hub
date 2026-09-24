import { KhError, parseInput } from "./errors";
import {
  type Actor,
  type Board,
  type Container,
  type ContainerCreateInput,
  type ContainerPatchInput,
  type Event,
  type EventType,
  type LogInput,
  type Project,
  type ProjectCreateInput,
  type ProjectPatchInput,
  type Task,
  type TaskCreateInput,
  type TaskPatchInput,
  type TaskStatus,
  containerCreateInput,
  containerPatchInput,
  containerSchema,
  logInput,
  projectCreateInput,
  projectPatchInput,
  projectSchema,
  taskCreateInput,
  taskPatchInput,
  taskSchema,
} from "./schema";

/** 变更函数的运行环境 */
export interface MutationContext {
  /** 当前时间（ISO 字符串），同一次变更里的所有时间都用它 */
  now: string;
  actor: Actor;
  newId: () => string;
}

export interface NewProjectResult {
  project: Project;
  board: Board;
  events: Event[];
}

export interface ProjectResult {
  project: Project;
  events: Event[];
}

export interface ContainerResult {
  board: Board;
  container: Container;
  events: Event[];
}

export interface TaskResult {
  board: Board;
  task: Task;
  events: Event[];
}

type FieldChange = Record<string, { from: unknown; to: unknown }>;
type TaskStatusFields = Pick<Task, "status" | "suspendReason" | "startedAt" | "completedAt">;

const PROJECT_KEYS = ["name", "description", "cycle", "health", "focus"] as const;
const CONTAINER_KEYS = ["code", "title", "order", "targetVersion", "targetDate", "manualStatus", "manualReason"] as const;
const TASK_FIELD_KEYS = [
  "containerId",
  "code",
  "title",
  "order",
  "group",
  "assigneeUserId",
  "note",
  "docRefs",
  "checklist",
  "dueDate",
] as const;

/**
 * 按规格 5.4 推算状态变化后的挂起原因与日期。任何状态之间都可以直接切换。
 * reason 为 undefined 表示沿用原来的挂起原因。
 */
export function transitionTask(
  task: TaskStatusFields,
  next: TaskStatus,
  now: string,
  reason?: string | null,
): TaskStatusFields {
  return {
    status: next,
    suspendReason: next === "suspended" ? (reason === undefined ? task.suspendReason : reason) : null,
    // 第一次进入进行中时记录，以后重新打开也不覆盖
    startedAt: task.startedAt ?? (next === "in_progress" ? now : null),
    // 进入已完成时记录；本来就是已完成则保持不变；离开已完成时清空
    completedAt: next === "done" ? (task.status === "done" && task.completedAt !== null ? task.completedAt : now) : null,
  };
}

export function createProject(input: ProjectCreateInput, ctx: MutationContext): NewProjectResult {
  const data = parseInput(projectCreateInput, input);
  const project = parseInput(projectSchema, {
    id: ctx.newId(),
    version: 1,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    name: data.name,
    description: data.description ?? "",
    cycle: data.cycle ?? "development",
    health: data.health ?? "on_track",
    focus: data.focus ?? "",
    fingerprint: data.fingerprint ?? null,
    locations: [],
  });
  // 每个项目自带一个杂项容器，不能删除（规格 5.2）
  const misc: Container = {
    id: ctx.newId(),
    version: 1,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    kind: "misc",
    code: null,
    title: "杂项",
    order: 0,
    targetVersion: null,
    targetDate: null,
    manualStatus: null,
    manualReason: null,
  };
  return {
    project,
    board: { containers: [misc], tasks: [] },
    events: [makeEvent(ctx, project.id, "project.created", { text: project.name })],
  };
}

export function updateProject(
  project: Project,
  patch: ProjectPatchInput,
  ctx: MutationContext,
  expectedVersion?: number,
): ProjectResult {
  const data = definedOnly(parseInput(projectPatchInput, patch));
  checkVersion(project, expectedVersion, "项目");
  const merged: Project = { ...project, ...data };
  const change = diffFields(project, merged, PROJECT_KEYS);
  if (!change) return { project, events: [] };
  const next = parseInput(projectSchema, { ...merged, version: project.version + 1, updatedAt: ctx.now });
  return { project: next, events: [makeEvent(ctx, project.id, "project.updated", { change })] };
}

export function createContainer(
  board: Board,
  projectId: string,
  input: ContainerCreateInput,
  ctx: MutationContext,
): ContainerResult {
  const data = parseInput(containerCreateInput, input);
  const container = parseInput(containerSchema, {
    id: ctx.newId(),
    version: 1,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    kind: data.kind,
    code: data.code ?? null,
    title: data.title,
    order: data.order ?? nextOrder(board.containers),
    targetVersion: data.targetVersion ?? null,
    targetDate: data.targetDate ?? null,
    manualStatus: data.manualStatus ?? null,
    manualReason: data.manualReason ?? null,
  });
  assertContainerCodeFree(board, container);
  return {
    board: { ...board, containers: [...board.containers, container] },
    container,
    events: [makeEvent(ctx, projectId, "container.created", { target: { containerId: container.id }, text: container.title })],
  };
}

export function updateContainer(
  board: Board,
  projectId: string,
  containerId: string,
  patch: ContainerPatchInput,
  ctx: MutationContext,
  expectedVersion?: number,
): ContainerResult {
  const data = definedOnly(parseInput(containerPatchInput, patch));
  const current = findContainer(board, containerId);
  checkVersion(current, expectedVersion, "容器");
  const merged: Container = { ...current, ...data };
  // 改回自动状态时，原因一并清空
  if (data.manualStatus === null && data.manualReason === undefined) merged.manualReason = null;
  const change = diffFields(current, merged, CONTAINER_KEYS);
  if (!change) return { board, container: current, events: [] };
  const container = parseInput(containerSchema, { ...merged, version: current.version + 1, updatedAt: ctx.now });
  assertContainerCodeFree(board, container);
  return {
    board: { ...board, containers: replaceById(board.containers, container) },
    container,
    events: [makeEvent(ctx, projectId, "container.updated", { target: { containerId }, change })],
  };
}

export function createTask(board: Board, projectId: string, input: TaskCreateInput, ctx: MutationContext): TaskResult {
  const data = parseInput(taskCreateInput, input);
  const container = findContainer(board, data.containerId);
  const status = data.status ?? "todo";
  if (data.suspendReason != null && status !== "suspended") {
    throw new KhError("invalid", "只有挂起的任务才能填写挂起原因");
  }
  const blank: Task = {
    id: ctx.newId(),
    version: 1,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    containerId: container.id,
    code: data.code ?? null,
    title: data.title,
    order: data.order ?? nextOrder(board.tasks.filter((t) => t.containerId === container.id)),
    status: "todo",
    suspendReason: null,
    human: data.human ?? null,
    group: data.group ?? null,
    assigneeUserId: data.assigneeUserId ?? null,
    note: data.note ?? "",
    docRefs: data.docRefs ?? [],
    checklist: data.checklist ?? [],
    dueDate: data.dueDate ?? null,
    startedAt: null,
    completedAt: null,
  };
  const task = parseInput(taskSchema, { ...blank, ...transitionTask(blank, status, ctx.now, data.suspendReason) });
  assertTaskCodeFree(board, task);
  return {
    board: { ...board, tasks: [...board.tasks, task] },
    task,
    events: [
      makeEvent(ctx, projectId, "task.created", {
        target: { containerId: task.containerId, taskId: task.id },
        text: task.title,
      }),
    ],
  };
}

export function updateTask(
  board: Board,
  projectId: string,
  taskId: string,
  patch: TaskPatchInput,
  ctx: MutationContext,
  expectedVersion?: number,
): TaskResult {
  const { status, suspendReason, ...fields } = definedOnly(parseInput(taskPatchInput, patch));
  const current = findTask(board, taskId);
  checkVersion(current, expectedVersion, "任务");
  const nextStatus = status ?? current.status;
  if (suspendReason != null && nextStatus !== "suspended") {
    throw new KhError("invalid", "只有挂起的任务才能填写挂起原因");
  }
  const merged: Task = { ...current, ...fields, ...transitionTask(current, nextStatus, ctx.now, suspendReason) };
  if (fields.containerId !== undefined && fields.containerId !== current.containerId) {
    findContainer(board, fields.containerId);
    // 换到别的容器又没指定顺序时，排到目标容器末尾
    if (fields.order === undefined) {
      merged.order = nextOrder(board.tasks.filter((t) => t.containerId === fields.containerId));
    }
  }
  const statusChange = diffFields(current, merged, ["status", "suspendReason"]);
  const humanChange = diffFields(current, merged, ["human"]);
  const fieldChange = diffFields(current, merged, TASK_FIELD_KEYS);
  if (!statusChange && !humanChange && !fieldChange) return { board, task: current, events: [] };

  const task = parseInput(taskSchema, { ...merged, version: current.version + 1, updatedAt: ctx.now });
  assertTaskCodeFree(board, task);
  const target = { containerId: task.containerId, taskId: task.id };
  const events: Event[] = [];
  if (statusChange) events.push(makeEvent(ctx, projectId, "task.status_changed", { target, change: statusChange }));
  if (humanChange) events.push(makeEvent(ctx, projectId, "task.human_changed", { target, change: humanChange }));
  if (fieldChange) events.push(makeEvent(ctx, projectId, "task.updated", { target, change: fieldChange }));
  return { board: { ...board, tasks: replaceById(board.tasks, task) }, task, events };
}

/** 时间线日志；可以关联到某个任务或容器 */
export function createLogEvent(board: Board, projectId: string, input: LogInput, ctx: MutationContext): Event {
  const data = parseInput(logInput, input);
  let target: Event["target"] = null;
  if (data.taskId !== undefined) {
    const task = findTask(board, data.taskId);
    target = { containerId: task.containerId, taskId: task.id };
  } else if (data.containerId !== undefined) {
    target = { containerId: findContainer(board, data.containerId).id };
  }
  return makeEvent(ctx, projectId, "log", { target, text: data.text });
}

// ---------- 内部工具 ----------

function makeEvent(
  ctx: MutationContext,
  projectId: string,
  type: EventType,
  fields: { target?: Event["target"]; change?: FieldChange | null; text?: string | null } = {},
): Event {
  return {
    id: ctx.newId(),
    ts: ctx.now,
    projectId,
    actor: ctx.actor,
    type,
    target: fields.target ?? null,
    change: fields.change ?? null,
    text: fields.text ?? null,
    imported: false,
  };
}

/** 比较指定字段，返回有变化的字段；全都没变返回 null */
function diffFields<T extends object>(before: T, after: T, keys: readonly (keyof T & string)[]): FieldChange | null {
  const change: FieldChange = {};
  for (const key of keys) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) change[key] = { from: before[key], to: after[key] };
  }
  return Object.keys(change).length > 0 ? change : null;
}

/** 去掉值为 undefined 的键：补丁里没写的字段保持原样，写成 null 才表示清空 */
function definedOnly<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function checkVersion(entity: { version: number }, expected: number | undefined, what: string): void {
  if (expected !== undefined && expected !== entity.version) {
    throw new KhError("conflict", `${what}已被更新，请刷新后重试`, { currentVersion: entity.version });
  }
}

function nextOrder(items: readonly { order: number }[]): number {
  return items.reduce((max, item) => Math.max(max, item.order + 1), 0);
}

function findContainer(board: Board, id: string): Container {
  const container = board.containers.find((c) => c.id === id);
  if (!container) throw new KhError("not_found", `容器 ${id} 不存在`);
  return container;
}

function findTask(board: Board, id: string): Task {
  const task = board.tasks.find((t) => t.id === id);
  if (!task) throw new KhError("not_found", `任务 ${id} 不存在`);
  return task;
}

function sameCode(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a.toLowerCase() === b.toLowerCase();
}

function assertContainerCodeFree(board: Board, container: Container): void {
  const clash = board.containers.find((c) => c.id !== container.id && sameCode(c.code, container.code));
  if (clash) throw new KhError("invalid", `编号“${container.code}”已被容器“${clash.title}”使用`);
}

function assertTaskCodeFree(board: Board, task: Task): void {
  const clash = board.tasks.find(
    (t) => t.id !== task.id && t.containerId === task.containerId && sameCode(t.code, task.code),
  );
  if (clash) throw new KhError("invalid", `同一个容器里，编号“${task.code}”已被任务“${clash.title}”使用`);
}

function replaceById<T extends { id: string }>(items: readonly T[], next: T): T[] {
  return items.map((item) => (item.id === next.id ? next : item));
}
