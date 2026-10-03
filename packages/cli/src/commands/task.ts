import type { Command } from "commander";
import { z } from "zod";
import { compareByOrder } from "@kanban-hub/core/derive";
import { resolveTaskRef } from "@kanban-hub/core/refs";
import type { ProjectDetailResponse } from "@kanban-hub/core/api";
import {
  dateSchema,
  TASK_STATUSES,
  taskCreateInput,
  taskPatchInput,
  taskReorderInput,
  taskSchema,
  type Board,
  type Container,
  type HumanKind,
  type Task,
} from "@kanban-hub/core/schema";
import type { CliContext } from "../context";
import { CliError, EXIT } from "../errors";
import type { ApiClient } from "../http/client";
import { toRepoPath } from "../repo/root";
import type { RegisteredRepo } from "../repo/root";
import { HUMAN_KIND_LABELS, TASK_STATUS_LABELS } from "./labels";
import {
  afterReport,
  assertAnyOptionGiven,
  containerRefLabel,
  displayEmpty,
  formatChange,
  globalAgentFlag,
  loadProject,
  parseEnumOption,
  parseInputOrFail,
  parseNullableDateOption,
  parseNullableOption,
  requireLogin,
  requireRegisteredRepo,
  resolveContainerOrFail,
  resolveTaskOrFail,
  shortRef,
  withAgentOption,
} from "./shared";

// ---------- 纯逻辑（不碰网络/文件系统，单元测试直接覆盖） ----------

/** --doc 去重：保留先出现的顺序 */
export function dedupePaths(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

/**
 * 清单项序号（从 1 开始）校验并转换成数组下标；不是正整数、或者超出清单长度都是用法错误（2）。
 * length 传清单的当前长度（改之前的），0 长度意味着任何序号都会越界。
 */
export function parseChecklistIndex(raw: string, length: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > length) {
    throw new CliError(EXIT.USAGE, `清单项序号不合法：${raw}`, `这个任务的清单共有 ${length} 项，序号从 1 开始`);
  }
  return n - 1;
}

export interface SetOptionsInput {
  status?: string;
  reason?: string;
  note?: string;
  doc: string[];
  title?: string;
  code?: string;
  group?: string;
  due?: string;
  container?: string;
}

/** kh task set 至少要给一个要修改的选项，否则用法错误（2），不发请求 */
export function assertHasSetOption(opts: SetOptionsInput): void {
  assertAnyOptionGiven([
    opts.status !== undefined,
    opts.reason !== undefined,
    opts.note !== undefined,
    opts.doc.length > 0,
    opts.title !== undefined,
    opts.code !== undefined,
    opts.group !== undefined,
    opts.due !== undefined,
    opts.container !== undefined,
  ]);
}

/**
 * --status suspended 却没给 --reason（或者给了空字符串）时本地拦截（用法错误 2），不发请求；
 * 核对用服务端 transitionTask 负责。
 */
export function assertSuspendReason(status: string | undefined, reason: string | undefined): void {
  if (status === "suspended" && (reason === undefined || reason === "")) {
    throw new CliError(EXIT.USAGE, '任务状态改为 suspended 时必须提供 --reason "<原因>"');
  }
}

export interface HumanOptionsInput {
  /** commander 的可选参数：给了但没跟值时是 true，给了值时是字符串，没给这个选项时是 undefined */
  decision?: string | true;
  verify?: string | true;
  action?: string | true;
  clear?: boolean;
}

/**
 * 三个类型选项互斥，恰好给一个，或者只给 --clear；给了类型却没有说明文字也是用法错误。
 * 返回要写入的 human 字段：null 表示清除。
 */
export function resolveHumanFlag(opts: HumanOptionsInput): { kind: HumanKind; note: string } | null {
  const entries: { kind: HumanKind; value: string | true | undefined }[] = [
    { kind: "decision", value: opts.decision },
    { kind: "verify", value: opts.verify },
    { kind: "action", value: opts.action },
  ];
  const given = entries.filter((e) => e.value !== undefined);

  if (opts.clear) {
    if (given.length > 0) throw new CliError(EXIT.USAGE, "--clear 不能和 --decision/--verify/--action 同时使用");
    return null;
  }
  if (given.length === 0) {
    throw new CliError(EXIT.USAGE, "请提供 --decision、--verify、--action 三者之一，或者 --clear");
  }
  if (given.length > 1) {
    throw new CliError(EXIT.USAGE, "--decision、--verify、--action 只能同时给一个");
  }

  const { kind, value } = given[0]!;
  // value === undefined 理论上不会发生（entries 已经按 !== undefined 过滤过），这里只是让 TS 收窄成 string
  if (value === true || value === undefined) {
    throw new CliError(EXIT.USAGE, `--${kind} 需要提供说明文字`);
  }
  return { kind, note: value };
}

function replaceTaskIn(tasks: readonly Task[], next: Task): Task[] {
  return tasks.map((t) => (t.id === next.id ? next : t));
}

/** commander 的自定义 option 处理：让 --doc / --add 可以重复给出，按顺序累积成数组 */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/**
 * task add 的 --due：新建任务没有“清空”的意义，给了就必须是合法日期（空字符串也是格式错误），
 * 与 --code、--group 不做清空处理保持一致；task set 的 --due 才用 shared 的
 * parseNullableDateOption（可以清空一个已有任务的截止日期）。
 */
function parseDueDateForAdd(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const result = dateSchema.safeParse(raw);
  if (!result.success) {
    throw new CliError(EXIT.USAGE, `截止日期格式不对：${raw}`, "使用 YYYY-MM-DD 格式，例如 2026-10-01");
  }
  return raw;
}

/**
 * 重排命令里的任务写法：# 开头的短 ID、含 / 的“容器编号/任务编号”照常解析；
 * 其余当作指定容器内的任务编号（容器已经由第一个参数确定，不必再写前缀）。
 */
function resolveReorderTask(board: Pick<Board, "containers" | "tasks">, container: Container, ref: string): Task {
  if (ref.startsWith("#") || ref.includes("/")) return resolveTaskOrFail(board, ref);
  const result = resolveTaskRef(board, `${container.id}/${ref}`);
  if (!result.ok && result.reason === "not_found") {
    // 不是本容器内的编号时，再按完整 ID 或 ID 前缀解析一次
    const byId = resolveTaskRef(board, ref);
    if (byId.ok) return board.tasks.find((x) => x.id === byId.id)!;
  }
  if (!result.ok) {
    const label = containerRefLabel(container, board.containers);
    throw new CliError(
      result.reason === "not_found" ? EXIT.USAGE : EXIT.DATA,
      result.reason === "not_found" ? `容器 ${label} 里没有编号为 ${ref} 的任务` : result.message,
    );
  }
  return board.tasks.find((x) => x.id === result.id)!;
}

export interface TaskReorderPlan {
  container: Container;
  /** 请求体里的任务 ID，按命令行给出的顺序 */
  taskIds: string[];
  /** 改之前该容器全部任务的 ID（按 order、createdAt、id） */
  before: string[];
}

/**
 * kh task reorder 的本地校验：解析容器和任务引用，参数重复、任务不属于该容器都是用法错误（2）。
 * 只做解析和校验，不碰网络，方便单元测试。
 */
export function planTaskReorder(
  board: Pick<Board, "containers" | "tasks">,
  containerRef: string,
  taskRefs: readonly string[],
): TaskReorderPlan {
  const container = resolveContainerOrFail(board, containerRef);
  const taskIds: string[] = [];
  for (const ref of taskRefs) {
    const task = resolveReorderTask(board, container, ref);
    if (taskIds.includes(task.id)) {
      throw new CliError(EXIT.USAGE, `任务重复出现：${ref}`, "同一个任务在参数里只能写一次");
    }
    if (task.containerId !== container.id) {
      const label = containerRefLabel(container, board.containers);
      throw new CliError(EXIT.USAGE, `任务 ${ref} 不属于容器 ${label}`, "只能重排同一个容器内的任务");
    }
    taskIds.push(task.id);
  }
  const before = board.tasks.filter((t) => t.containerId === container.id).sort(compareByOrder).map((t) => t.id);
  return { container, taskIds, before };
}

/** 重排结果的输出：顺序没有变化时只有一行，否则首行加逐行的新顺序 */
export function formatTaskReorder(
  board: Pick<Board, "containers" | "tasks">,
  container: Container,
  before: readonly string[],
  after: readonly Task[],
): string {
  if (after.length === before.length && after.every((t, i) => t.id === before[i])) return "顺序未变化";
  const lines = after.map((t, i) => {
    const code = t.code !== null ? ` ${t.code}` : "";
    return `  ${i + 1}. ${shortRef(board, t.id)}${code} ${t.title}（${TASK_STATUS_LABELS[t.status]}）`;
  });
  return [`已重排 ${containerRefLabel(container, board.containers)} 的任务顺序：`, ...lines].join("\n");
}

interface TaskEditContext {
  repo: RegisteredRepo;
  client: ApiClient;
  detail: ProjectDetailResponse;
  task: Task;
}

/**
 * set/human/check/checklist 共用的前置步骤：登录、拉项目详情、按引用解析出任务。
 * repo 由调用方先拿好传进来（不在这里调用 requireRegisteredRepo）：set 需要在网络请求之前，
 * 用 repo.root 把 --doc 换算成仓库内路径、校验 --due 的格式，这些本地校验要排在网络请求之前。
 */
async function loadTaskEditContext(
  ctx: CliContext,
  cmd: Command,
  repo: RegisteredRepo,
  taskRef: string,
): Promise<TaskEditContext> {
  const { client } = await requireLogin(ctx, globalAgentFlag(cmd));
  const detail = await loadProject(client, repo.config.projectId);
  const task = resolveTaskOrFail(detail.board, taskRef);
  return { repo, client, detail, task };
}

/** PATCH 一个任务，返回服务端的最新任务和按更新后看板算出的短 ID */
async function patchTask(
  client: ApiClient,
  projectId: string,
  taskId: string,
  tasks: readonly Task[],
  patch: unknown,
): Promise<{ updated: Task; ref: string }> {
  const updated = await client.patch(`/api/v1/projects/${projectId}/tasks/${taskId}`, patch, taskSchema);
  const ref = shortRef({ tasks: replaceTaskIn(tasks, updated) }, updated.id);
  return { updated, ref };
}

// ---------- 命令实现 ----------

interface AddOptions {
  code?: string;
  group?: string;
  doc: string[];
  due?: string;
}

async function runAdd(ctx: CliContext, containerRef: string, title: string, opts: AddOptions, cmd: Command): Promise<void> {
  const repo = await requireRegisteredRepo(ctx);

  // --due、--doc 都能在本地校验，排在拉项目详情（网络请求）之前：服务端连不上时，
  // 这类用法错误本该是 2，不能因为先发了网络请求而变成 4（与 container 保持一致）
  const dueDate = parseDueDateForAdd(opts.due);
  const docRefs = opts.doc.length > 0 ? opts.doc.map((d) => toRepoPath(repo.root, ctx.cwd, d)) : undefined;

  const { client } = await requireLogin(ctx, globalAgentFlag(cmd));
  const detail = await loadProject(client, repo.config.projectId);
  const container = resolveContainerOrFail(detail.board, containerRef);

  const candidate: Record<string, unknown> = { containerId: container.id, title };
  if (opts.code !== undefined) candidate.code = opts.code;
  if (opts.group !== undefined) candidate.group = opts.group;
  if (dueDate !== undefined) candidate.dueDate = dueDate;
  if (docRefs !== undefined) candidate.docRefs = docRefs;

  const input = parseInputOrFail(taskCreateInput, candidate);
  const task = await client.post(`/api/v1/projects/${repo.config.projectId}/tasks`, input, taskSchema);

  // 短 ID 按更新后的看板计算：把刚创建的任务并入本地已有的看板，不用为此多打一次请求
  const updatedBoard = { ...detail.board, tasks: [...detail.board.tasks, task] };
  const ref = shortRef(updatedBoard, task.id);
  const codePart = task.code !== null ? `（${containerRefLabel(container, detail.board.containers)}/${task.code}）` : "";
  ctx.stdout.write(`已新建任务 ${ref}${codePart}：${task.title}\n`);

  await afterReport(ctx, repo.config.projectId);
}

type SetOptions = SetOptionsInput;

async function runSet(ctx: CliContext, taskRef: string, opts: SetOptions, cmd: Command): Promise<void> {
  assertHasSetOption(opts);
  const status = opts.status !== undefined ? parseEnumOption(opts.status, TASK_STATUSES, TASK_STATUS_LABELS) : undefined;
  assertSuspendReason(status, opts.reason);

  const repo = await requireRegisteredRepo(ctx);

  // 同 runAdd：--due、--doc 的本地校验排在拉项目详情（网络请求）之前
  const due = parseNullableDateOption(opts.due);
  const docsToAdd = opts.doc.length > 0 ? opts.doc.map((d) => toRepoPath(repo.root, ctx.cwd, d)) : undefined;

  const { client, detail, task } = await loadTaskEditContext(ctx, cmd, repo, taskRef);

  const candidate: Record<string, unknown> = {};
  if (status !== undefined) candidate.status = status;
  if (opts.reason !== undefined) candidate.suspendReason = opts.reason;
  if (opts.note !== undefined) candidate.note = opts.note;
  if (opts.title !== undefined) candidate.title = opts.title;

  const code = parseNullableOption(opts.code);
  if (code !== undefined) candidate.code = code;
  const group = parseNullableOption(opts.group);
  if (group !== undefined) candidate.group = group;
  if (due !== undefined) candidate.dueDate = due;

  let targetContainer: Container | undefined;
  if (opts.container !== undefined) {
    targetContainer = resolveContainerOrFail(detail.board, opts.container);
    candidate.containerId = targetContainer.id;
  }

  // --doc 是追加：并入已有 docRefs 后去重，而不是替换
  let docRefs: string[] | undefined;
  if (docsToAdd !== undefined) {
    docRefs = dedupePaths([...task.docRefs, ...docsToAdd]);
    candidate.docRefs = docRefs;
  }

  const patch = parseInputOrFail(taskPatchInput, candidate);
  const { updated, ref } = await patchTask(client, repo.config.projectId, task.id, detail.board.tasks, patch);

  const changes: string[] = [];
  if (status !== undefined) changes.push(formatChange("状态", TASK_STATUS_LABELS[task.status], TASK_STATUS_LABELS[updated.status]));
  if (opts.reason !== undefined) changes.push(formatChange("挂起原因", displayEmpty(task.suspendReason), displayEmpty(updated.suspendReason)));
  if (opts.note !== undefined) changes.push(formatChange("备注", displayEmpty(task.note), displayEmpty(updated.note)));
  if (opts.title !== undefined) changes.push(formatChange("标题", displayEmpty(task.title), displayEmpty(updated.title)));
  if (code !== undefined) changes.push(formatChange("编号", displayEmpty(task.code), displayEmpty(updated.code)));
  if (group !== undefined) changes.push(formatChange("分组", displayEmpty(task.group), displayEmpty(updated.group)));
  if (due !== undefined) changes.push(formatChange("截止日期", displayEmpty(task.dueDate), displayEmpty(updated.dueDate)));
  if (targetContainer !== undefined) {
    const from = detail.board.containers.find((c) => c.id === task.containerId);
    const fromLabel = from ? containerRefLabel(from, detail.board.containers) : task.containerId;
    changes.push(formatChange("所属容器", fromLabel, containerRefLabel(targetContainer, detail.board.containers)));
  }
  if (docRefs !== undefined) changes.push(formatChange("关联文档", `${task.docRefs.length} 项`, `${updated.docRefs.length} 项`));

  ctx.stdout.write(`已更新 ${ref}：${changes.join("；") || "没有变化"}\n`);
  await afterReport(ctx, repo.config.projectId);
}

async function runHuman(ctx: CliContext, taskRef: string, opts: HumanOptionsInput, cmd: Command): Promise<void> {
  const human = resolveHumanFlag(opts);
  const repo = await requireRegisteredRepo(ctx);
  const { client, detail, task } = await loadTaskEditContext(ctx, cmd, repo, taskRef);

  const patch = parseInputOrFail(taskPatchInput, { human });
  const { updated, ref } = await patchTask(client, repo.config.projectId, task.id, detail.board.tasks, patch);

  const from = task.human ? `${HUMAN_KIND_LABELS[task.human.kind]}：${task.human.note}` : displayEmpty(null);
  const to = updated.human ? `${HUMAN_KIND_LABELS[updated.human.kind]}：${updated.human.note}` : displayEmpty(null);
  ctx.stdout.write(`已更新 ${ref}：待你处理 ${from} → ${to}\n`);

  await afterReport(ctx, repo.config.projectId);
}

interface CheckOptions {
  undo?: boolean;
}

async function runCheck(ctx: CliContext, taskRef: string, indexRaw: string, opts: CheckOptions, cmd: Command): Promise<void> {
  const repo = await requireRegisteredRepo(ctx);
  const { client, detail, task } = await loadTaskEditContext(ctx, cmd, repo, taskRef);

  const index = parseChecklistIndex(indexRaw, task.checklist.length);
  const done = !opts.undo;
  const checklist = task.checklist.map((item, i) => (i === index ? { ...item, done } : item));

  const patch = parseInputOrFail(taskPatchInput, { checklist });
  const { updated, ref } = await patchTask(client, repo.config.projectId, task.id, detail.board.tasks, patch);
  const item = updated.checklist[index]!;
  ctx.stdout.write(`已${done ? "勾选" : "取消勾选"} ${ref} 清单第 ${index + 1} 项：${item.text}\n`);

  await afterReport(ctx, repo.config.projectId);
}

interface ChecklistOptions {
  add: string[];
}

async function runChecklist(ctx: CliContext, taskRef: string, opts: ChecklistOptions, cmd: Command): Promise<void> {
  if (opts.add.length === 0) throw new CliError(EXIT.USAGE, '至少提供一个 --add "<内容>"');

  const repo = await requireRegisteredRepo(ctx);
  const { client, detail, task } = await loadTaskEditContext(ctx, cmd, repo, taskRef);

  const checklist = [...task.checklist, ...opts.add.map((text) => ({ text, done: false }))];
  const patch = parseInputOrFail(taskPatchInput, { checklist });
  const { updated, ref } = await patchTask(client, repo.config.projectId, task.id, detail.board.tasks, patch);
  ctx.stdout.write(`已追加 ${opts.add.length} 项到 ${ref} 的清单（现有 ${updated.checklist.length} 项）\n`);

  await afterReport(ctx, repo.config.projectId);
}

async function runReorder(ctx: CliContext, containerRef: string, taskRefs: string[], cmd: Command): Promise<void> {
  const repo = await requireRegisteredRepo(ctx);
  const { client } = await requireLogin(ctx, globalAgentFlag(cmd));
  const detail = await loadProject(client, repo.config.projectId);
  const plan = planTaskReorder(detail.board, containerRef, taskRefs);

  const input = parseInputOrFail(taskReorderInput, { taskIds: plan.taskIds });
  const after = await client.post(
    `/api/v1/projects/${repo.config.projectId}/containers/${plan.container.id}/reorder-tasks`,
    input,
    z.array(taskSchema),
  );
  ctx.stdout.write(`${formatTaskReorder(detail.board, plan.container, plan.before, after)}\n`);
}

/** kh task：新增、修改、标记待你处理、清单（规格 10.2，另加“与规格的出入”第 2 条：task set 的附加选项） */
export function registerTask(program: Command, ctx: CliContext): void {
  const task = program.command("task").description("任务：新增、修改、标记待你处理、清单");

  withAgentOption(
    task
      .command("add")
      .description("在指定容器下新建任务")
      .argument("<容器>", "容器写法：编号、misc 或 ID 前缀")
      .argument("<标题>", "任务标题")
      .option("--code <编号>", "任务编号")
      .option("--group <标签>", "分组标签")
      .option("--doc <路径>", "关联的仓库内文档路径（可重复给出）", collect, [] as string[])
      .option("--due <日期>", "截止日期，例如 2026-10-01"),
  ).action(async (containerRef: string, title: string, opts: AddOptions, cmd: Command) => {
    await runAdd(ctx, containerRef, title, opts, cmd);
  });

  withAgentOption(
    task
      .command("set")
      .description("修改任务的字段（至少要给一个选项）")
      .argument("<任务>", "任务写法：#短ID、容器编号/任务编号 或完整 ID")
      .option("--status <状态>", `任务状态：${TASK_STATUSES.map((s) => `${s}（${TASK_STATUS_LABELS[s]}）`).join("、")}`)
      .option("--reason <原因>", "挂起原因，--status suspended 时必须提供")
      .option("--note <备注>", "备注，传空串清空")
      .option("--doc <路径>", "追加关联文档路径（可重复给出，自动去重）", collect, [] as string[])
      .option("--title <标题>", "标题")
      .option("--code <编号>", "任务编号，传空串清空")
      .option("--group <标签>", "分组标签，传空串清空")
      .option("--due <日期>", "截止日期，传空串清空")
      .option("--container <容器>", "把任务移到另一个容器"),
  ).action(async (taskRef: string, opts: SetOptions, cmd: Command) => {
    await runSet(ctx, taskRef, opts, cmd);
  });

  withAgentOption(
    task
      .command("human")
      .description("设置或清除任务的待你处理标记（三个类型互斥，恰好给一个，或者只给 --clear）")
      .argument("<任务>", "任务写法")
      .option("--decision [说明]", "待决策")
      .option("--verify [说明]", "待验证")
      .option("--action [说明]", "待操作")
      .option("--clear", "清除待你处理标记"),
  ).action(async (taskRef: string, opts: HumanOptionsInput, cmd: Command) => {
    await runHuman(ctx, taskRef, opts, cmd);
  });

  withAgentOption(
    task
      .command("check")
      .description("勾选或取消勾选清单项（序号从 1 开始）")
      .argument("<任务>", "任务写法")
      .argument("<序号>", "清单项序号，从 1 开始")
      .option("--undo", "取消勾选（标回未完成）"),
  ).action(async (taskRef: string, indexRaw: string, opts: CheckOptions, cmd: Command) => {
    await runCheck(ctx, taskRef, indexRaw, opts, cmd);
  });

  withAgentOption(
    task
      .command("checklist")
      .description("给任务追加清单项")
      .argument("<任务>", "任务写法")
      .option("--add <内容>", "追加一项清单内容（可重复给出，按顺序追加）", collect, [] as string[]),
  ).action(async (taskRef: string, opts: ChecklistOptions, cmd: Command) => {
    await runChecklist(ctx, taskRef, opts, cmd);
  });

  withAgentOption(
    task
      .command("reorder")
      .description("调整容器内任务的顺序：列出的任务排在最前，没列出的保持原有相对顺序")
      .argument("<容器>", "容器写法：编号、misc 或 ID 前缀")
      .argument("<任务...>", "任务写法：本容器内的任务编号、#短ID 或 容器编号/任务编号，至少一个，按期望的先后顺序给出"),
  ).action(async (containerRef: string, taskRefs: string[], _opts: unknown, cmd: Command) => {
    await runReorder(ctx, containerRef, taskRefs, cmd);
  });
}
