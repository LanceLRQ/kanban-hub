import { z } from "zod";
import { idSchema } from "./ids";
import { SYNC_MAX_FILE_SIZE_LIMIT } from "./sync";

// 校验提示统一用中文（全局设置，对所有 zod schema 生效）
z.config(z.locales.zhCN());

// ---------- 基础类型 ----------

/** 带时区的 ISO 8601 时间，例如 2026-09-23T10:00:00.000Z */
export const timestampSchema = z.iso.datetime({ offset: true });
/** 日期，例如 2026-09-23 */
export const dateSchema = z.iso.date();
/** 容器与任务的编号：不能含空白、/ 和 #，这三个字符在命令行写法里另有含义（规格 10.2） */
export const codeSchema = z
  .string()
  .min(1)
  .max(20)
  .regex(/^[^\s/#]+$/, "编号不能包含空白、/ 或 #");
export const titleSchema = z.string().trim().min(1).max(200);

/** 仓库内的相对路径：POSIX 形式，不能是绝对路径，不能含 .. 或空段 */
export function isRepoRelativePath(p: string): boolean {
  if (p === "" || p.startsWith("/") || p.includes("\\") || /^[A-Za-z]:/.test(p)) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}
export const repoPathSchema = z
  .string()
  .max(500)
  .refine(isRepoRelativePath, "必须是仓库内的相对路径（POSIX 形式，不含 ..）");

// ---------- 工具类型 ----------

/** 深度只读：给查询接口的返回值用，约束调用方不能直接改内部状态；只做编译期检查，不做深拷贝 */
export type DeepReadonly<T> = T extends readonly (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

// ---------- 枚举（规格 5.3） ----------

export const CYCLES = ["design", "development", "iteration", "maintenance", "archived"] as const;
export const HEALTHS = ["on_track", "at_risk", "blocked"] as const;
export const TASK_STATUSES = ["todo", "in_progress", "review", "done", "suspended", "cancelled"] as const;
export const HUMAN_KINDS = ["decision", "verify", "action"] as const;
export const CONTAINER_KINDS = ["phase", "feature", "misc"] as const;
export const MANUAL_STATUSES = ["backlog", "suspended", "cancelled"] as const;
export const USER_ROLES = ["admin", "member"] as const;
export const MACHINE_OSES = ["darwin", "linux", "windows"] as const;
export const ACTOR_VIAS = ["web", "cli"] as const;
export const EVENT_TYPES = [
  "project.created",
  "project.updated",
  "container.created",
  "container.updated",
  "task.created",
  "task.updated",
  "task.status_changed",
  "task.human_changed",
  "log",
  "docs.synced",
  "docs.pulled",
  "import.applied",
] as const;

export const cycleSchema = z.enum(CYCLES);
export const healthSchema = z.enum(HEALTHS);
export const taskStatusSchema = z.enum(TASK_STATUSES);
export const humanKindSchema = z.enum(HUMAN_KINDS);
export const containerKindSchema = z.enum(CONTAINER_KINDS);
export const manualStatusSchema = z.enum(MANUAL_STATUSES);
export const userRoleSchema = z.enum(USER_ROLES);
export const machineOsSchema = z.enum(MACHINE_OSES);
export const actorViaSchema = z.enum(ACTOR_VIAS);
export const eventTypeSchema = z.enum(EVENT_TYPES);

export type Cycle = z.infer<typeof cycleSchema>;
export type Health = z.infer<typeof healthSchema>;
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type HumanKind = z.infer<typeof humanKindSchema>;
export type ContainerKind = z.infer<typeof containerKindSchema>;
export type ManualStatus = z.infer<typeof manualStatusSchema>;
export type UserRole = z.infer<typeof userRoleSchema>;
export type MachineOs = z.infer<typeof machineOsSchema>;
export type ActorVia = z.infer<typeof actorViaSchema>;
export type EventType = z.infer<typeof eventTypeSchema>;

// ---------- 实体（规格 5.1、5.2） ----------

const entityFields = {
  id: idSchema,
  version: z.number().int().min(1),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
};

export const userSchema = z.object({
  ...entityFields,
  name: z.string().trim().min(1).max(100),
  role: userRoleSchema,
  passwordHash: z.string().min(1),
  sessionVersion: z.number().int().min(0),
});
export type User = z.infer<typeof userSchema>;

export const machineSchema = z.object({
  ...entityFields,
  name: z.string().trim().min(1).max(100),
  userId: idSchema,
  os: machineOsSchema,
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/, "必须是 64 位十六进制的 SHA-256"),
  lastSeenAt: timestampSchema.nullable(),
  revokedAt: timestampSchema.nullable(),
});
export type Machine = z.infer<typeof machineSchema>;

export const gitStateSchema = z.object({
  branch: z.string().nullable(),
  head: z.string().nullable(),
  headSubject: z.string().nullable(),
  headAt: timestampSchema.nullable(),
  dirtyCount: z.number().int().min(0),
  // 没有上游分支时为 null
  ahead: z.number().int().min(0).nullable(),
  behind: z.number().int().min(0).nullable(),
});
export type GitState = z.infer<typeof gitStateSchema>;

export const syncScopeSchema = z.object({
  include: z.array(z.string().min(1)),
  exclude: z.array(z.string().min(1)),
  maxFileSize: z.number().int().positive().max(SYNC_MAX_FILE_SIZE_LIMIT, `不能超过 ${SYNC_MAX_FILE_SIZE_LIMIT} 字节`),
});
export type SyncScope = z.infer<typeof syncScopeSchema>;

export const locationSchema = z.object({
  machineId: idSchema,
  path: z.string().min(1),
  lastSyncAt: timestampSchema.nullable(),
  sync: syncScopeSchema.nullable(),
  git: gitStateSchema.nullable(),
  skippedFiles: z.array(z.object({ path: repoPathSchema, size: z.number().int().min(0) })),
});
export type Location = z.infer<typeof locationSchema>;

/** 项目的字段（不带跨字段校验，可以 pick / partial） */
export const projectFields = z.object({
  ...entityFields,
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500),
  cycle: cycleSchema,
  health: healthSchema,
  focus: z.string().max(200),
  fingerprint: z
    .string()
    .regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, "必须是 git 提交 hash")
    .nullable(),
  locations: z.array(locationSchema),
});
export const projectSchema = projectFields.superRefine((p, ctx) => {
  const seen = new Set<string>();
  p.locations.forEach((loc, i) => {
    if (seen.has(loc.machineId)) {
      ctx.addIssue({ code: "custom", path: ["locations", i, "machineId"], message: "同一台机器只能有一个位置" });
    }
    seen.add(loc.machineId);
  });
});
export type Project = z.infer<typeof projectSchema>;

/** 容器的字段（不带跨字段校验，可以 pick / partial） */
export const containerFields = z.object({
  ...entityFields,
  kind: containerKindSchema,
  code: codeSchema.nullable(),
  title: titleSchema,
  order: z.number().int().min(0),
  targetVersion: z.string().trim().min(1).max(50).nullable(),
  targetDate: dateSchema.nullable(),
  manualStatus: manualStatusSchema.nullable(),
  manualReason: z.string().trim().min(1).max(500).nullable(),
});
export const containerSchema = containerFields.superRefine((c, ctx) => {
  if (c.manualStatus === "suspended" && c.manualReason === null) {
    ctx.addIssue({ code: "custom", path: ["manualReason"], message: "容器挂起时必须填写原因" });
  }
  if (c.manualStatus === null && c.manualReason !== null) {
    ctx.addIssue({ code: "custom", path: ["manualReason"], message: "没有手动状态时不能填写原因" });
  }
  if (c.kind === "misc" && c.manualStatus !== null) {
    ctx.addIssue({ code: "custom", path: ["manualStatus"], message: "杂项容器不能手动设置状态" });
  }
  if (c.code !== null && c.code.toLowerCase() === "misc") {
    ctx.addIssue({ code: "custom", path: ["code"], message: "编号 misc 已留给杂项容器" });
  }
});
export type Container = z.infer<typeof containerSchema>;

export const humanFlagSchema = z.object({
  kind: humanKindSchema,
  note: z.string().trim().min(1).max(500),
});
export type HumanFlag = z.infer<typeof humanFlagSchema>;

export const checklistItemSchema = z.object({
  text: z.string().trim().min(1).max(200),
  done: z.boolean(),
});
export type ChecklistItem = z.infer<typeof checklistItemSchema>;

/** 任务的字段（不带跨字段校验，可以 pick / partial） */
export const taskFields = z.object({
  ...entityFields,
  containerId: idSchema,
  code: codeSchema.nullable(),
  title: titleSchema,
  order: z.number().int().min(0),
  status: taskStatusSchema,
  suspendReason: z.string().trim().min(1).max(500).nullable(),
  human: humanFlagSchema.nullable(),
  group: z.string().trim().min(1).max(50).nullable(),
  assigneeUserId: idSchema.nullable(),
  note: z.string().max(1000),
  docRefs: z.array(repoPathSchema).max(50),
  checklist: z.array(checklistItemSchema).max(100),
  dueDate: dateSchema.nullable(),
  startedAt: timestampSchema.nullable(),
  completedAt: timestampSchema.nullable(),
});
export const taskSchema = taskFields.superRefine((t, ctx) => {
  if (t.status === "suspended" && t.suspendReason === null) {
    ctx.addIssue({ code: "custom", path: ["suspendReason"], message: "任务挂起时必须填写原因" });
  }
  if (t.status !== "suspended" && t.suspendReason !== null) {
    ctx.addIssue({ code: "custom", path: ["suspendReason"], message: "只有挂起的任务才有挂起原因" });
  }
  if (t.status !== "done" && t.completedAt !== null) {
    ctx.addIssue({ code: "custom", path: ["completedAt"], message: "只有已完成的任务才有完成时间" });
  }
});
export type Task = z.infer<typeof taskSchema>;

/** board.yaml：一个项目的全部容器与任务（规格 6.1） */
export const boardSchema = z
  .object({
    containers: z.array(containerSchema),
    tasks: z.array(taskSchema),
  })
  .superRefine((b, ctx) => {
    const miscCount = b.containers.filter((c) => c.kind === "misc").length;
    if (miscCount !== 1) {
      ctx.addIssue({ code: "custom", path: ["containers"], message: `必须有且只有一个杂项容器（现在有 ${miscCount} 个）` });
    }
    const containerIds = new Set<string>();
    b.containers.forEach((c, i) => {
      if (containerIds.has(c.id)) ctx.addIssue({ code: "custom", path: ["containers", i, "id"], message: "容器 ID 重复" });
      containerIds.add(c.id);
    });
    const taskIds = new Set<string>();
    b.tasks.forEach((t, i) => {
      if (taskIds.has(t.id)) ctx.addIssue({ code: "custom", path: ["tasks", i, "id"], message: "任务 ID 重复" });
      taskIds.add(t.id);
      if (!containerIds.has(t.containerId)) {
        ctx.addIssue({ code: "custom", path: ["tasks", i, "containerId"], message: "引用了不存在的容器" });
      }
    });
  });
export type Board = z.infer<typeof boardSchema>;

// ---------- 事件（规格 5.2；id 是计划新增的分页游标） ----------

export const actorSchema = z
  .object({
    userId: idSchema,
    machineId: idSchema.nullable(),
    via: actorViaSchema,
    agent: z.string().trim().min(1).max(50).nullable(),
  })
  .superRefine((a, ctx) => {
    if (a.via === "cli" && a.machineId === null) {
      ctx.addIssue({ code: "custom", path: ["machineId"], message: "来自命令行的操作必须带机器 ID" });
    }
  });
export type Actor = z.infer<typeof actorSchema>;

export const eventTargetSchema = z.object({
  containerId: idSchema.optional(),
  taskId: idSchema.optional(),
});

/** 字段变化。from / to 允许缺省：JSON 序列化会丢掉值为 undefined 的键 */
export const fieldChangeSchema = z.object({
  from: z.unknown().optional(),
  to: z.unknown().optional(),
});

export const eventSchema = z.object({
  id: idSchema,
  ts: timestampSchema,
  projectId: idSchema,
  actor: actorSchema,
  type: eventTypeSchema,
  target: eventTargetSchema.nullable(),
  change: z.record(z.string(), fieldChangeSchema).nullable(),
  text: z.string().max(10000).nullable(),
  imported: z.boolean(),
});
export type Event = z.infer<typeof eventSchema>;

// ---------- 变更输入（存储层与 M2 的 API 共用；拒绝未知字段） ----------

export const projectCreateInput = projectFields
  .pick({ name: true, description: true, cycle: true, health: true, focus: true, fingerprint: true })
  .partial({ description: true, cycle: true, health: true, focus: true, fingerprint: true })
  .strict();
export type ProjectCreateInput = z.input<typeof projectCreateInput>;

export const projectPatchInput = projectFields
  .pick({ name: true, description: true, cycle: true, health: true, focus: true })
  .partial()
  .strict();
export type ProjectPatchInput = z.input<typeof projectPatchInput>;

export const containerCreateInput = containerFields
  .pick({ code: true, title: true, order: true, targetVersion: true, targetDate: true, manualStatus: true, manualReason: true })
  .partial({ code: true, order: true, targetVersion: true, targetDate: true, manualStatus: true, manualReason: true })
  // 杂项容器随项目自动创建，不能手动新建
  .extend({ kind: z.enum(["phase", "feature"]) })
  .strict();
export type ContainerCreateInput = z.input<typeof containerCreateInput>;

export const containerPatchInput = containerFields
  .pick({ code: true, title: true, order: true, targetVersion: true, targetDate: true, manualStatus: true, manualReason: true })
  .partial()
  .strict();
export type ContainerPatchInput = z.input<typeof containerPatchInput>;

const taskInputKeys = {
  containerId: true,
  code: true,
  title: true,
  order: true,
  status: true,
  suspendReason: true,
  human: true,
  group: true,
  assigneeUserId: true,
  note: true,
  docRefs: true,
  checklist: true,
  dueDate: true,
} as const;

export const taskCreateInput = taskFields
  .pick(taskInputKeys)
  .partial({
    code: true,
    order: true,
    status: true,
    suspendReason: true,
    human: true,
    group: true,
    assigneeUserId: true,
    note: true,
    docRefs: true,
    checklist: true,
    dueDate: true,
  })
  .strict();
export type TaskCreateInput = z.input<typeof taskCreateInput>;

export const taskPatchInput = taskFields.pick(taskInputKeys).partial().strict();
export type TaskPatchInput = z.input<typeof taskPatchInput>;

export const logInput = z
  .object({
    text: z.string().trim().min(1).max(10000),
    containerId: idSchema.optional(),
    taskId: idSchema.optional(),
  })
  .strict();
export type LogInput = z.input<typeof logInput>;

/** 登记项目在某台机器上的位置；lastSyncAt、git、skippedFiles 由服务端在 M5 维护，不经这个输入设置 */
export const locationInput = z
  .object({
    path: z.string().min(1).max(1000),
    sync: syncScopeSchema.nullable().optional(),
  })
  .strict();
export type LocationInput = z.input<typeof locationInput>;
