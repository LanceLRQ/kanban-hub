import { z } from "zod";
import { CONTAINER_KIND_LABELS, CONTAINER_STATUS_LABELS, CYCLE_LABELS, HEALTH_LABELS, TASK_STATUS_LABELS } from "./labels";
import { containerStatus, projectProgress } from "./derive";
import { KhError, parseInput } from "./errors";
import { createContainer, createTask, transitionTask, type MutationContext } from "./mutations";
import {
  boardSchema,
  codeSchema,
  containerKindSchema,
  containerSchema,
  cycleSchema,
  dateSchema,
  healthSchema,
  humanKindSchema,
  manualStatusSchema,
  projectSchema,
  repoPathSchema,
  taskSchema,
  taskStatusSchema,
  timestampSchema,
  titleSchema,
  type Board,
  type Container,
  type ContainerKind,
  type Event,
  type Project,
  type Task,
  type TaskStatus,
} from "./schema";

/** 导入导出文件的格式标识 */
export const TRANSFER_FORMAT = "kanban-hub/v1";

// ---------- 文本字段的类型提示 ----------

const TEXT_HINT = '需要文本，数字或 true/false 请加引号，例如 "1.10"';

/**
 * 给文本类字段包一层类型检查：YAML 会把 2.3 解析成数字、把 1.10 解析成 1.1，把没加引号的
 * true/false 解析成布尔值，这些转换会悄悄丢信息，所以遇到数字或布尔值一律报错，不自动转换。
 * 其余类型（数组、对象等）留给内层 schema 报出常规的类型错误。
 */
function text<S extends z.ZodType>(inner: S): z.ZodPipe<z.ZodType<unknown>, S> {
  return z
    .unknown()
    .superRefine((val, ctx) => {
      if (typeof val === "number" || typeof val === "boolean") {
        ctx.addIssue({ code: "custom", message: TEXT_HINT });
      }
    })
    .pipe(inner);
}

// ---------- 文件里单个容器 / 任务 / 项目字段 / 历史日志 ----------

const importHumanSchema = z
  .object({
    kind: humanKindSchema,
    note: text(z.string().trim().min(1).max(500)),
  })
  .strict();

const importChecklistItemSchema = z
  .object({
    text: text(z.string().trim().min(1).max(200)),
    done: z.boolean(),
  })
  .strict();

const importTaskSchema = z
  .object({
    code: text(codeSchema).nullable().optional(),
    title: text(titleSchema).optional(),
    status: taskStatusSchema.optional(),
    suspendReason: text(z.string().trim().min(1).max(500)).nullable().optional(),
    human: importHumanSchema.nullable().optional(),
    group: text(z.string().trim().min(1).max(50)).nullable().optional(),
    note: text(z.string().max(1000)).optional(),
    docRefs: z.array(text(repoPathSchema)).max(50).optional(),
    checklist: z.array(importChecklistItemSchema).max(100).optional(),
    dueDate: dateSchema.nullable().optional(),
    startedAt: timestampSchema.nullable().optional(),
    completedAt: timestampSchema.nullable().optional(),
  })
  .strict()
  .superRefine((t, ctx) => {
    if (t.status === "suspended" && (t.suspendReason === undefined || t.suspendReason === null)) {
      ctx.addIssue({ code: "custom", path: ["suspendReason"], message: "挂起的任务必须填写挂起原因" });
    }
    if (t.completedAt != null && t.status !== undefined && t.status !== "done") {
      ctx.addIssue({ code: "custom", path: ["completedAt"], message: "只有已完成的任务才能填写完成时间" });
    }
  });
export type ImportTask = z.infer<typeof importTaskSchema>;

const importContainerSchema = z
  .object({
    kind: containerKindSchema,
    code: text(codeSchema).nullable().optional(),
    title: text(titleSchema).optional(),
    targetVersion: text(z.string().trim().min(1).max(50)).nullable().optional(),
    targetDate: dateSchema.nullable().optional(),
    manualStatus: manualStatusSchema.nullable().optional(),
    manualReason: text(z.string().trim().min(1).max(500)).nullable().optional(),
    tasks: z.array(importTaskSchema).optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.manualStatus === "suspended" && (c.manualReason === undefined || c.manualReason === null)) {
      ctx.addIssue({ code: "custom", path: ["manualReason"], message: "容器挂起时必须填写原因" });
    }
    if (c.kind === "misc" && c.manualStatus != null) {
      ctx.addIssue({ code: "custom", path: ["manualStatus"], message: "杂项容器不能手动设置状态" });
    }
  });
export type ImportContainer = z.infer<typeof importContainerSchema>;

const importEventSchema = z
  .object({
    ts: timestampSchema,
    text: text(z.string().trim().min(1).max(10000)),
  })
  .strict();
export type ImportEvent = z.infer<typeof importEventSchema>;

const importProjectSchema = z
  .object({
    cycle: cycleSchema.optional(),
    health: healthSchema.optional(),
    focus: text(z.string().max(200)).optional(),
  })
  .strict();

/** 导入导出文件的整体形状 */
export const transferDocSchema = z
  .object({
    format: z.literal(TRANSFER_FORMAT),
    project: importProjectSchema.optional(),
    containers: z.array(importContainerSchema),
    events: z.array(importEventSchema).optional(),
  })
  .strict()
  .superRefine((doc, ctx) => {
    const miscCount = doc.containers.filter((c) => c.kind === "misc").length;
    if (miscCount > 1) {
      ctx.addIssue({ code: "custom", path: ["containers"], message: "杂项容器最多只能有一个" });
    }
  });
export type TransferDoc = z.infer<typeof transferDocSchema>;

// ---------- 历史日志去重键 ----------

/** 历史日志的去重键：时间规范成 UTC 的 ISO 字符串，与正文一起判重 */
export function importLogKey(ts: string, text: string): string {
  return JSON.stringify([new Date(ts).toISOString(), text]);
}

// ---------- 导入结果摘要 ----------

export const importSummarySchema = z.object({
  dryRun: z.boolean(),
  project: z.array(z.object({ field: z.string(), from: z.unknown(), to: z.unknown() })),
  containers: z.object({
    created: z.array(z.object({ label: z.string() })),
    updated: z.array(z.object({ label: z.string(), fields: z.array(z.string()) })),
  }),
  tasks: z.object({
    created: z.array(z.object({ container: z.string(), title: z.string() })),
    updated: z.array(z.object({ container: z.string(), title: z.string(), fields: z.array(z.string()) })),
    statusChanges: z.array(z.object({ container: z.string(), title: z.string(), from: z.string(), to: z.string() })),
  }),
  events: z.object({ added: z.number().int().min(0), duplicates: z.number().int().min(0) }),
});
export type ImportSummary = z.infer<typeof importSummarySchema>;

export interface ImportPlan {
  project: Project | null;
  board: Board | null;
  events: Event[];
  summary: Omit<ImportSummary, "dryRun">;
}

// ---------- import.applied 事件的 change（与 sync.ts 的 docsSyncedChange / readDocsCounts 同一种写法） ----------

export interface ImportAppliedCounts {
  projectFields: string[];
  containersCreated: number;
  containersUpdated: number;
  tasksCreated: number;
  tasksUpdated: number;
  logsAdded: number;
}

interface FieldChangeShape {
  from?: unknown;
  to?: unknown;
}

export function importAppliedChange(counts: ImportAppliedCounts): Record<string, FieldChangeShape> {
  return {
    projectFields: { to: [...counts.projectFields] },
    containersCreated: { to: counts.containersCreated },
    containersUpdated: { to: counts.containersUpdated },
    tasksCreated: { to: counts.tasksCreated },
    tasksUpdated: { to: counts.tasksUpdated },
    logsAdded: { to: counts.logsAdded },
  };
}

/** 从事件里读出 import.applied 的计数，与 importAppliedChange 互为逆运算；类型或形状不对时返回 null */
export function readImportCounts(event: Event): ImportAppliedCounts | null {
  if (event.type !== "import.applied") return null;
  const change = event.change;
  const projectFields = change?.["projectFields"]?.to;
  const containersCreated = change?.["containersCreated"]?.to;
  const containersUpdated = change?.["containersUpdated"]?.to;
  const tasksCreated = change?.["tasksCreated"]?.to;
  const tasksUpdated = change?.["tasksUpdated"]?.to;
  const logsAdded = change?.["logsAdded"]?.to;
  if (!Array.isArray(projectFields) || !projectFields.every((f) => typeof f === "string")) return null;
  if (
    typeof containersCreated !== "number" ||
    typeof containersUpdated !== "number" ||
    typeof tasksCreated !== "number" ||
    typeof tasksUpdated !== "number" ||
    typeof logsAdded !== "number"
  ) {
    return null;
  }
  return { projectFields, containersCreated, containersUpdated, tasksCreated, tasksUpdated, logsAdded };
}

// ---------- planImport ----------

/** 容器/任务在导入摘要里的显示标签：有编号用编号，杂项用 misc，否则用标题 */
function entryLabel(entry: { code: string | null; kind?: ContainerKind; title: string }): string {
  if (entry.code) return entry.code;
  if (entry.kind === "misc") return "misc";
  return entry.title;
}

/** 判断两个可能为 null 的时间字符串是否指向同一时刻：同一时刻换一种时区写法不算变化 */
function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return new Date(a).getTime() === new Date(b).getTime();
}

/** 把文件里的时间规范成 new Date(x).toISOString() */
function normalizeInstant(ts: string): string {
  return new Date(ts).toISOString();
}

function normalizeNullableInstant(ts: string | null): string | null {
  return ts === null ? null : normalizeInstant(ts);
}

/**
 * 按“不分大小写”的规则合并编号：文件里给了新编号时，若与当前编号只是大小写不同，
 * 保留原有写法（不算变化）；否则采用文件里的写法（新建、真正改了编号、或补写编号）。
 */
function mergeCode(current: string | null, fileCode: string | null): string | null {
  if (current !== null && fileCode !== null && current.toLowerCase() === fileCode.toLowerCase()) return current;
  return fileCode;
}

interface MatchPool<T> {
  items: T[];
  matched: Set<number>;
}

function makePool<T>(items: readonly T[]): MatchPool<T> {
  return { items: [...items], matched: new Set() };
}

/**
 * 在池子里按编号（不分大小写）或标题匹配一个未被匹配过的条目；找到后标记为已匹配。
 * 编号在池子里找不到时，再找一个没有编号、标题相同的条目作为兜底，
 * 匹配上后把文件里的编号写给它（返回时带上 adoptedCode 标记，调用方据此补写编号）。
 */
function matchInPool<T extends { code: string | null; title: string }>(
  pool: MatchPool<T>,
  fileCode: string | null,
  fileTitle: string | null,
): { entry: T; index: number; adoptedCode: string | null } | null {
  if (fileCode !== null) {
    for (let i = 0; i < pool.items.length; i++) {
      if (pool.matched.has(i)) continue;
      const item = pool.items[i]!;
      if (item.code !== null && item.code.toLowerCase() === fileCode.toLowerCase()) {
        pool.matched.add(i);
        return { entry: item, index: i, adoptedCode: null };
      }
    }
    // 兜底：没有编号、标题相同的已有条目
    if (fileTitle !== null) {
      for (let i = 0; i < pool.items.length; i++) {
        if (pool.matched.has(i)) continue;
        const item = pool.items[i]!;
        if (item.code === null && item.title === fileTitle) {
          pool.matched.add(i);
          return { entry: item, index: i, adoptedCode: fileCode };
        }
      }
    }
    return null;
  }
  if (fileTitle === null) return null;
  for (let i = 0; i < pool.items.length; i++) {
    if (pool.matched.has(i)) continue;
    const item = pool.items[i]!;
    if (item.title === fileTitle) {
      pool.matched.add(i);
      return { entry: item, index: i, adoptedCode: null };
    }
  }
  return null;
}

function normalizeMatchKey(code: string | null, title: string | null): string {
  return code !== null ? `code:${code.toLowerCase()}` : `title:${title ?? ""}`;
}

/** 按 kind + code / kind + title 校验文件内是否有重复的容器匹配键 */
function assertNoDuplicateContainerKeys(containers: readonly ImportContainer[]): void {
  const seen = new Map<string, number>();
  containers.forEach((c, i) => {
    if (c.kind === "misc") return;
    const key = `${c.kind}:${normalizeMatchKey(c.code ?? null, c.title ?? null)}`;
    const prev = seen.get(key);
    if (prev !== undefined) {
      throw new KhError("invalid", `导入文件里 containers[${prev}] 与 containers[${i}] 的匹配键相同`, {
        issues: [`containers[${i}]：与 containers[${prev}] 的匹配键相同`],
      });
    }
    seen.set(key, i);
  });
}

function assertNoDuplicateTaskKeys(containerIndex: number, tasks: readonly ImportTask[]): void {
  const seen = new Map<string, number>();
  tasks.forEach((t, i) => {
    const key = normalizeMatchKey(t.code ?? null, t.title ?? null);
    const prev = seen.get(key);
    if (prev !== undefined) {
      throw new KhError(
        "invalid",
        `导入文件里 containers[${containerIndex}].tasks[${prev}] 与 containers[${containerIndex}].tasks[${i}] 的匹配键相同`,
        { issues: [`containers[${containerIndex}].tasks[${i}]：与 tasks[${prev}] 的匹配键相同`] },
      );
    }
    seen.set(key, i);
  });
}

const CONTAINER_TEXT_KEYS = ["title", "targetVersion", "targetDate", "manualStatus", "manualReason"] as const;
const TASK_TEXT_KEYS = ["title", "group", "note", "docRefs", "checklist", "human"] as const;

/** 编号（不分大小写）已被同一范围内的其他条目占用时，按文件里的位置报错 */
function assertCodeFree(
  items: readonly { id: string; code: string | null; title: string }[],
  selfId: string | null,
  code: string | null,
  path: string,
  what: string,
): void {
  if (code === null) return;
  const clash = items.find((i) => i.id !== selfId && i.code !== null && i.code.toLowerCase() === code.toLowerCase());
  if (!clash) return;
  const issue = `${path}：编号 ${code} 与已有的${what}“${clash.title}”重复`;
  throw new KhError("invalid", `数据校验失败：${issue}`, { issues: [issue] });
}

function changed(before: unknown, after: unknown): boolean {
  return JSON.stringify(before) !== JSON.stringify(after);
}

export function planImport(
  state: { project: Project; board: Board },
  doc: TransferDoc,
  existingLogKeys: ReadonlySet<string>,
  ctx: MutationContext,
): ImportPlan {
  assertNoDuplicateContainerKeys(doc.containers);

  // ---------- 项目字段 ----------
  const projectFieldChanges: { field: string; from: unknown; to: unknown }[] = [];
  const projectPatch: Partial<Pick<Project, "cycle" | "health" | "focus">> = {};
  if (doc.project?.cycle !== undefined && doc.project.cycle !== state.project.cycle) {
    projectFieldChanges.push({ field: "cycle", from: state.project.cycle, to: doc.project.cycle });
    projectPatch.cycle = doc.project.cycle;
  }
  if (doc.project?.health !== undefined && doc.project.health !== state.project.health) {
    projectFieldChanges.push({ field: "health", from: state.project.health, to: doc.project.health });
    projectPatch.health = doc.project.health;
  }
  if (doc.project?.focus !== undefined && doc.project.focus !== state.project.focus) {
    projectFieldChanges.push({ field: "focus", from: state.project.focus, to: doc.project.focus });
    projectPatch.focus = doc.project.focus;
  }

  // ---------- 容器与任务 ----------
  let board: Board = state.board;
  const nonMiscPool = makePool<Container>(board.containers.filter((c) => c.kind !== "misc"));

  const containersCreated: { label: string }[] = [];
  const containersUpdated: { label: string; fields: string[] }[] = [];
  const tasksCreated: { container: string; title: string }[] = [];
  const tasksUpdated: { container: string; title: string; fields: string[] }[] = [];
  const statusChanges: { container: string; title: string; from: string; to: string }[] = [];
  // 生成了新版本的已有任务数（含只改状态的），用于 import.applied 的“更新的任务”计数
  let tasksVersioned = 0;

  doc.containers.forEach((fc, fcIndex) => {
    let container: Container;
    let isNew = false;

    if (fc.kind === "misc") {
      container = board.containers.find((c) => c.kind === "misc")!;
    } else {
      const fileCode = fc.code ?? null;
      const fileTitle = fc.title !== undefined ? fc.title.trim() : null;
      const match = matchInPool(nonMiscPool, fileCode, fileTitle);
      if (match) {
        container = match.entry;
      } else {
        assertCodeFree(board.containers, null, fc.code ?? null, `containers[${fcIndex}].code`, "容器");
        const input = {
          kind: fc.kind as "phase" | "feature",
          code: fc.code ?? undefined,
          title: fc.title ?? "",
          targetVersion: fc.targetVersion ?? undefined,
          targetDate: fc.targetDate ?? undefined,
          manualStatus: fc.manualStatus ?? undefined,
          manualReason: fc.manualReason ?? undefined,
        };
        const result = createContainer(board, state.project.id, input, ctx);
        board = result.board;
        container = result.container;
        isNew = true;
      }
    }

    if (isNew) {
      containersCreated.push({ label: entryLabel(container) });
    } else {
      const merged: Container = { ...container };
      if (fc.title !== undefined) merged.title = fc.title;
      if (fc.code !== undefined) merged.code = mergeCode(container.code, fc.code);
      if (fc.targetVersion !== undefined) merged.targetVersion = fc.targetVersion;
      if (fc.targetDate !== undefined) merged.targetDate = fc.targetDate;
      if (fc.manualStatus !== undefined) merged.manualStatus = fc.manualStatus;
      if (fc.manualReason !== undefined) merged.manualReason = fc.manualReason;

      const changedFields = CONTAINER_TEXT_KEYS.filter((k) => changed(container[k], merged[k]));
      const codeChanged = container.code !== merged.code;
      if (changedFields.length > 0 || codeChanged) {
        if (codeChanged) assertCodeFree(board.containers, container.id, merged.code, `containers[${fcIndex}].code`, "容器");
        const next = parseInput(containerSchema, { ...merged, version: container.version + 1, updatedAt: ctx.now });
        board = { ...board, containers: board.containers.map((c) => (c.id === next.id ? next : c)) };
        containersUpdated.push({ label: entryLabel(next), fields: [...changedFields, ...(codeChanged ? ["code"] : [])] });
        container = next;
      }
    }

    if (!fc.tasks || fc.tasks.length === 0) return;
    assertNoDuplicateTaskKeys(fcIndex, fc.tasks);

    const containerId = container.id;
    const containerLabel = entryLabel(container);
    const taskPool = makePool<Task>(board.tasks.filter((t) => t.containerId === containerId));

    for (const [ti, ft] of fc.tasks.entries()) {
      const fileCode = ft.code ?? null;
      const fileTitle = ft.title !== undefined ? ft.title.trim() : null;
      const match = matchInPool(taskPool, fileCode, fileTitle);

      const codePath = `containers[${fcIndex}].tasks[${ti}].code`;
      const ownTasks = () => board.tasks.filter((t) => t.containerId === containerId);

      if (!match) {
        assertCodeFree(ownTasks(), null, ft.code ?? null, codePath, "任务");
        const input = {
          containerId,
          code: ft.code ?? undefined,
          title: ft.title ?? "",
          status: ft.status ?? undefined,
          suspendReason: ft.suspendReason ?? undefined,
          human: ft.human ?? undefined,
          group: ft.group ?? undefined,
          note: ft.note ?? undefined,
          docRefs: ft.docRefs ?? undefined,
          checklist: ft.checklist ?? undefined,
          dueDate: ft.dueDate ?? undefined,
        };
        const result = createTask(board, state.project.id, input, ctx);
        let task = result.task;
        board = result.board;
        const dateOverrides: Partial<Task> = {};
        if (ft.startedAt !== undefined) dateOverrides.startedAt = normalizeNullableInstant(ft.startedAt);
        if (ft.completedAt !== undefined) dateOverrides.completedAt = normalizeNullableInstant(ft.completedAt);
        if (Object.keys(dateOverrides).length > 0) {
          task = parseInput(taskSchema, { ...task, ...dateOverrides });
          board = { ...board, tasks: board.tasks.map((t) => (t.id === task.id ? task : t)) };
        }
        tasksCreated.push({ container: containerLabel, title: task.title });
        continue;
      }

      const task = match.entry;

      if (ft.code !== undefined) assertCodeFree(ownTasks(), task.id, mergeCode(task.code, ft.code), codePath, "任务");

      const nextStatus: TaskStatus = ft.status ?? task.status;
      const statusFields = transitionTask(task, nextStatus, ctx.now, ft.suspendReason);
      const merged: Task = { ...task, ...statusFields };
      if (ft.title !== undefined) merged.title = ft.title;
      if (ft.code !== undefined) merged.code = mergeCode(task.code, ft.code);
      if (ft.human !== undefined) merged.human = ft.human;
      if (ft.group !== undefined) merged.group = ft.group;
      if (ft.note !== undefined) merged.note = ft.note;
      if (ft.docRefs !== undefined) merged.docRefs = ft.docRefs;
      if (ft.checklist !== undefined) merged.checklist = ft.checklist;
      if (ft.dueDate !== undefined) merged.dueDate = ft.dueDate;
      if (ft.startedAt !== undefined) merged.startedAt = normalizeNullableInstant(ft.startedAt);
      if (ft.completedAt !== undefined) merged.completedAt = normalizeNullableInstant(ft.completedAt);

      const statusChanged = task.status !== merged.status;
      const suspendReasonChanged = changed(task.suspendReason, merged.suspendReason);
      const startedChanged = !sameInstant(task.startedAt, merged.startedAt);
      const completedChanged = !sameInstant(task.completedAt, merged.completedAt);
      const codeChanged = task.code !== merged.code;
      const otherChangedFields = TASK_TEXT_KEYS.filter((k) => changed(task[k], merged[k]));
      const dueDateChanged = task.dueDate !== merged.dueDate;

      const fieldsChanged = [
        ...otherChangedFields,
        ...(dueDateChanged ? ["dueDate"] : []),
        ...(startedChanged ? ["startedAt"] : []),
        ...(completedChanged ? ["completedAt"] : []),
        ...(codeChanged ? ["code"] : []),
        // 挂起原因变了但状态没变（例如改写挂起原因）时单独计入；状态变化时已经体现在 statusChanges 里
        ...(!statusChanged && suspendReasonChanged ? ["suspendReason"] : []),
      ];

      const anyChange =
        statusChanged || suspendReasonChanged || startedChanged || completedChanged || codeChanged || otherChangedFields.length > 0 || dueDateChanged;

      if (!anyChange) {
        board = { ...board, tasks: board.tasks.map((t) => (t.id === task.id ? merged : t)) };
        continue;
      }

      const next = parseInput(taskSchema, { ...merged, version: task.version + 1, updatedAt: ctx.now });
      board = { ...board, tasks: board.tasks.map((t) => (t.id === next.id ? next : t)) };
      tasksVersioned += 1;

      if (statusChanged) {
        statusChanges.push({ container: containerLabel, title: next.title, from: task.status, to: next.status });
      }
      if (fieldsChanged.length > 0) {
        tasksUpdated.push({ container: containerLabel, title: next.title, fields: fieldsChanged });
      }
    }
  });

  // ---------- 历史日志 ----------
  const fileLogKeys = new Set<string>();
  let logsAdded = 0;
  let logsDuplicates = 0;
  const logEvents: Event[] = [];
  const fiveMinutesMs = 5 * 60 * 1000;

  for (const [ei, fe] of (doc.events ?? []).entries()) {
    const normalizedTs = normalizeInstant(fe.ts);
    if (Date.parse(normalizedTs) - Date.parse(ctx.now) > fiveMinutesMs) {
      const issue = `events[${ei}].ts：${fe.ts} 晚于导入时间 5 分钟以上`;
      throw new KhError("invalid", `数据校验失败：${issue}`, { issues: [issue] });
    }
    const key = importLogKey(fe.ts, fe.text);
    if (existingLogKeys.has(key) || fileLogKeys.has(key)) {
      logsDuplicates += 1;
      continue;
    }
    fileLogKeys.add(key);
    logsAdded += 1;
    logEvents.push({
      id: ctx.newId(),
      ts: normalizedTs,
      projectId: state.project.id,
      actor: ctx.actor,
      type: "log",
      target: null,
      change: null,
      text: fe.text,
      imported: true,
    });
  }

  // ---------- 汇总与 import.applied ----------
  const hasProjectChange = projectFieldChanges.length > 0;
  // 只改状态的任务不进 tasksUpdated（它的变化在 statusChanges 里），但同样生成了新版本，看板要写入
  const hasBoardChange = containersCreated.length > 0 || containersUpdated.length > 0 || tasksCreated.length > 0 || tasksVersioned > 0;
  const hasAnyChange = hasProjectChange || hasBoardChange || logsAdded > 0;

  const summary: Omit<ImportSummary, "dryRun"> = {
    project: projectFieldChanges,
    containers: { created: containersCreated, updated: containersUpdated },
    tasks: { created: tasksCreated, updated: tasksUpdated, statusChanges },
    events: { added: logsAdded, duplicates: logsDuplicates },
  };

  if (!hasAnyChange) {
    return { project: null, board: null, events: [], summary };
  }

  const nextProject =
    Object.keys(projectPatch).length > 0
      ? parseInput(projectSchema, { ...state.project, ...projectPatch, version: state.project.version + 1, updatedAt: ctx.now })
      : null;
  const nextBoard = hasBoardChange ? parseInput(boardSchema, board) : null;

  const appliedEvent: Event = {
    id: ctx.newId(),
    ts: ctx.now,
    projectId: state.project.id,
    actor: ctx.actor,
    type: "import.applied",
    target: null,
    change: importAppliedChange({
      projectFields: projectFieldChanges.map((f) => f.field),
      containersCreated: containersCreated.length,
      containersUpdated: containersUpdated.length,
      tasksCreated: tasksCreated.length,
      tasksUpdated: tasksVersioned,
      logsAdded,
    }),
    text: null,
    imported: false,
  };

  return { project: nextProject, board: nextBoard, events: [appliedEvent, ...logEvents], summary };
}

// ---------- 导出 ----------

function compact<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

/** 把项目、看板与历史日志打成一份导出文件，格式与导入相同 */
export function buildExportDoc(project: Project, board: Board, logs: readonly Event[]): TransferDoc {
  const sortedContainers = [...board.containers].sort((a, b) => a.order - b.order);
  return {
    format: TRANSFER_FORMAT,
    project: { cycle: project.cycle, health: project.health, focus: project.focus },
    containers: sortedContainers.map((c) =>
      compact({
        kind: c.kind,
        code: c.code ?? undefined,
        title: c.title,
        targetVersion: c.targetVersion ?? undefined,
        targetDate: c.targetDate ?? undefined,
        manualStatus: c.manualStatus ?? undefined,
        manualReason: c.manualReason ?? undefined,
        tasks: board.tasks
          .filter((t) => t.containerId === c.id)
          .sort((a, b) => a.order - b.order)
          .map((t) =>
            compact({
              code: t.code ?? undefined,
              title: t.title,
              status: t.status,
              suspendReason: t.suspendReason ?? undefined,
              human: t.human ?? undefined,
              group: t.group ?? undefined,
              note: t.note === "" ? undefined : t.note,
              docRefs: t.docRefs.length > 0 ? t.docRefs : undefined,
              checklist: t.checklist.length > 0 ? t.checklist : undefined,
              dueDate: t.dueDate ?? undefined,
              startedAt: t.startedAt ?? undefined,
              completedAt: t.completedAt ?? undefined,
            }),
          ),
      }),
    ),
    events: logs
      .filter((e) => e.type === "log")
      .slice()
      .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
      .map((e) => ({ ts: e.ts, text: e.text ?? "" })),
  };
}

/** Markdown 转义：只转义 `|`（避免被当成表格分隔），保持简单 */
function escapeMd(s: string): string {
  return s.replace(/\|/g, "\\|");
}

/** 列表项里的多行文本压成一行：换行替换成空格，否则会把列表拆开 */
function singleLine(s: string): string {
  return s.replace(/\s*[\r\n]+\s*/g, " ");
}

function formatDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("zh-CN", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

/** 渲染看板的 Markdown 导出 */
export function renderBoardMarkdown(project: Project, board: Board, opts: { now: Date; timeZone: string }): string {
  const lines: string[] = [];
  lines.push(`# ${project.name}`);
  lines.push("");
  const progress = projectProgress(board);
  lines.push(
    `周期：${CYCLE_LABELS[project.cycle]} ・ 健康度：${HEALTH_LABELS[project.health]} ・ 进度：${progress.done}/${progress.total} ・ 导出时间：${formatDate(
      opts.now.toISOString(),
      opts.timeZone,
    )}`,
  );
  if (project.focus) lines.push(`当前焦点：${project.focus}`);
  lines.push("");

  const sortedContainers = [...board.containers].sort((a, b) => a.order - b.order);
  for (const container of sortedContainers) {
    const tasks = board.tasks.filter((t) => t.containerId === container.id).sort((a, b) => a.order - b.order);
    const status = containerStatus(container, tasks);
    const kindLabel = CONTAINER_KIND_LABELS[container.kind];
    const statusLabel = status ? CONTAINER_STATUS_LABELS[status] : null;
    const counted = tasks.filter((t) => t.status !== "cancelled");
    const done = counted.filter((t) => t.status === "done").length;
    const heading = container.code ? `${container.code} ${container.title}` : container.title;
    lines.push(`## ${escapeMd(heading)}（${kindLabel}${statusLabel ? ` · ${statusLabel}` : ""} · ${done}/${counted.length}）`);
    lines.push("");
    for (const task of tasks) {
      const cancelled = task.status === "cancelled";
      const title = cancelled ? `~~${escapeMd(task.title)}~~` : escapeMd(task.title);
      const parts = [`- ${task.code ? `[${task.code}] ` : ""}${title}`, `（${TASK_STATUS_LABELS[task.status]}）`];
      if (task.group) parts.push(`#${task.group}`);
      if (task.human) parts.push(`待你处理：${singleLine(task.human.note)}`);
      if (task.note) parts.push(singleLine(task.note));
      if (task.dueDate) parts.push(`截止：${task.dueDate}`);
      if (task.checklist.length > 0) {
        const doneCount = task.checklist.filter((i) => i.done).length;
        parts.push(`清单 ${doneCount}/${task.checklist.length}`);
      }
      lines.push(parts.join(" "));
    }
    lines.push("");
  }
  return lines.join("\n");
}

