import type { Command } from "commander";
import { formatZodError } from "@kanban-hub/core/errors";
import { shortIdPrefixes } from "@kanban-hub/core/ids";
import {
  containerCreateInput,
  containerPatchInput,
  containerSchema,
  dateSchema,
  MANUAL_STATUSES,
  type ManualStatus,
} from "@kanban-hub/core/schema";
import type { CliContext } from "../context";
import { CliError, EXIT } from "../errors";
import { MANUAL_STATUS_LABELS } from "./labels";
import {
  afterReport,
  globalAgentFlag,
  loadProject,
  parseEnumOption,
  parseNullableOption,
  requireLogin,
  requireRegisteredRepo,
  resolveContainerOrFail,
} from "./shared";

const CONTAINER_KIND_VALUES = ["phase", "feature"] as const;
type ContainerAddKind = (typeof CONTAINER_KIND_VALUES)[number];
const CONTAINER_KIND_LABELS: Record<ContainerAddKind, string> = { phase: "阶段", feature: "特性" };

/** container set 的 --status 在手动状态之外多一个 auto，表示恢复自动（manualStatus: null） */
const CONTAINER_STATUS_VALUES = [...MANUAL_STATUSES, "auto"] as const;
const CONTAINER_STATUS_LABELS: Record<(typeof CONTAINER_STATUS_VALUES)[number], string> = {
  ...MANUAL_STATUS_LABELS,
  auto: "自动",
};
const CONTAINER_STATUS_OPTION_HINT = CONTAINER_STATUS_VALUES.map((v) => `${v}（${CONTAINER_STATUS_LABELS[v]}）`).join("、");

function manualStatusLabel(status: ManualStatus | null): string {
  return status === null ? "自动" : MANUAL_STATUS_LABELS[status];
}

/** 可空字段展示：null 显示成“（无）”，非空原样显示 */
function displayOrEmpty(value: string | null): string {
  return value ?? "（无）";
}

/**
 * 校验命令行传入的可空日期选项：不传（undefined）表示不改动字段，传空字符串表示清空（null），
 * 其余按 core 的 dateSchema 校验格式（YYYY-MM-DD），格式不对时是用法错误。抽成纯函数方便单元测试。
 */
export function parseTargetDateOption(raw: string | undefined): string | null | undefined {
  const value = parseNullableOption(raw);
  if (typeof value !== "string") return value;
  const result = dateSchema.safeParse(value);
  if (!result.success) {
    throw new CliError(EXIT.USAGE, `目标日期格式不对：${value}`, "使用 YYYY-MM-DD 格式，例如 2026-09-25");
  }
  return value;
}

export interface ContainerAddOptions {
  code?: string;
  version?: string;
  targetDate?: string;
}

export interface ContainerSetOptions {
  status?: string;
  reason?: string;
  title?: string;
  code?: string;
  version?: string;
  targetDate?: string;
}

/**
 * 校验 container add 的参数并整理成请求体：种类必须是 phase/feature（不合法时列出可选值），
 * 其余选项按“清空可空字段”的约定处理。抽成纯函数方便单元测试，不涉及网络；重复编号这类只有
 * 服务端才知道的合法性问题不在这里检查（交给服务端返回 400，kh 只负责透传退出码）。
 */
export function buildContainerCreateInput(rawKind: string, title: string, opts: ContainerAddOptions) {
  const kind = parseEnumOption(rawKind, CONTAINER_KIND_VALUES, CONTAINER_KIND_LABELS);

  const input: Record<string, unknown> = { kind, title };
  if (opts.code !== undefined) input.code = parseNullableOption(opts.code);
  if (opts.version !== undefined) input.targetVersion = parseNullableOption(opts.version);
  if (opts.targetDate !== undefined) input.targetDate = parseTargetDateOption(opts.targetDate);

  const parsed = containerCreateInput.safeParse(input);
  if (!parsed.success) throw new CliError(EXIT.USAGE, formatZodError(parsed.error).join("；"));
  return { kind, data: parsed.data };
}

/**
 * 校验 container set 的选项并整理成请求体：至少要给一个选项；--status suspended 却没给
 * --reason 在本地就是用法错误，不发请求；杂项容器不能设状态这类合法性问题交给服务端判断。
 * 抽成纯函数方便单元测试，不涉及网络。
 */
export function buildContainerPatch(opts: ContainerSetOptions) {
  if (
    opts.status === undefined &&
    opts.reason === undefined &&
    opts.title === undefined &&
    opts.code === undefined &&
    opts.version === undefined &&
    opts.targetDate === undefined
  ) {
    throw new CliError(
      EXIT.USAGE,
      "请至少提供一个要修改的选项",
      "可选：--status、--reason、--title、--code、--version、--target-date",
    );
  }

  const patch: Record<string, unknown> = {};

  if (opts.status !== undefined) {
    const statusOption = parseEnumOption(opts.status, CONTAINER_STATUS_VALUES, CONTAINER_STATUS_LABELS);
    const manualStatus = statusOption === "auto" ? null : statusOption;
    if (manualStatus === "suspended" && opts.reason === undefined) {
      throw new CliError(EXIT.USAGE, "设置挂起状态时必须提供 --reason", '例如：--status suspended --reason "等待联调"');
    }
    patch.manualStatus = manualStatus;
  }
  if (opts.reason !== undefined) patch.manualReason = parseNullableOption(opts.reason);
  if (opts.title !== undefined) patch.title = opts.title;
  if (opts.code !== undefined) patch.code = parseNullableOption(opts.code);
  if (opts.version !== undefined) patch.targetVersion = parseNullableOption(opts.version);
  if (opts.targetDate !== undefined) patch.targetDate = parseTargetDateOption(opts.targetDate);

  const parsed = containerPatchInput.safeParse(patch);
  if (!parsed.success) throw new CliError(EXIT.USAGE, formatZodError(parsed.error).join("；"));
  return parsed.data;
}

async function runContainerAdd(
  ctx: CliContext,
  rawKind: string,
  title: string,
  opts: ContainerAddOptions,
  agentFlag: string | undefined,
): Promise<void> {
  const { kind, data } = buildContainerCreateInput(rawKind, title, opts);

  const repo = await requireRegisteredRepo(ctx);
  const { client } = await requireLogin(ctx, agentFlag);
  const before = await loadProject(client, repo.config.projectId);
  const created = await client.post(`/api/v1/projects/${repo.config.projectId}/containers`, data, containerSchema);

  // POST 只返回新建的容器本身，短 ID 前缀要在整个看板的容器范围内取最短唯一前缀（至少 4 位）
  const prefixes = shortIdPrefixes([...before.board.containers.map((c) => c.id), created.id]);
  const prefix = prefixes.get(created.id) ?? created.id;
  const codeLabel = created.code ?? "（无编号）";

  ctx.stdout.write(`已新建${CONTAINER_KIND_LABELS[kind]}容器 ${codeLabel}（${prefix}）：${created.title}\n`);
  await afterReport(ctx, repo.config.projectId);
}

async function runContainerSet(
  ctx: CliContext,
  ref: string,
  opts: ContainerSetOptions,
  agentFlag: string | undefined,
): Promise<void> {
  const patch = buildContainerPatch(opts);

  const repo = await requireRegisteredRepo(ctx);
  const { client } = await requireLogin(ctx, agentFlag);
  const project = await loadProject(client, repo.config.projectId);
  const before = resolveContainerOrFail(project.board, ref);

  const updated = await client.patch(
    `/api/v1/projects/${repo.config.projectId}/containers/${before.id}`,
    patch,
    containerSchema,
  );

  const changes: string[] = [];
  if (opts.status !== undefined) {
    changes.push(`状态 ${manualStatusLabel(before.manualStatus)} → ${manualStatusLabel(updated.manualStatus)}`);
  }
  if (opts.reason !== undefined) changes.push(`原因 ${displayOrEmpty(before.manualReason)} → ${displayOrEmpty(updated.manualReason)}`);
  if (opts.title !== undefined) changes.push(`标题 ${before.title} → ${updated.title}`);
  if (opts.code !== undefined) changes.push(`编号 ${displayOrEmpty(before.code)} → ${displayOrEmpty(updated.code)}`);
  if (opts.version !== undefined) changes.push(`版本 ${displayOrEmpty(before.targetVersion)} → ${displayOrEmpty(updated.targetVersion)}`);
  if (opts.targetDate !== undefined) changes.push(`目标日期 ${displayOrEmpty(before.targetDate)} → ${displayOrEmpty(updated.targetDate)}`);

  const refLabel = before.code ?? before.id;
  ctx.stdout.write(`已更新容器 ${refLabel}：${changes.join("；")}\n`);
  await afterReport(ctx, repo.config.projectId);
}

/** kh container add / set：新建、修改阶段 / 特性 / 杂项容器（规格 10.2） */
export function registerContainer(program: Command, ctx: CliContext): void {
  const container = program.command("container").description("容器相关命令");

  container
    .command("add")
    .description("新建阶段或特性容器")
    .argument("<种类>", "phase（阶段）或 feature（特性）")
    .argument("<标题>", "容器标题")
    .option("--code <编号>", "容器编号")
    .option("--version <版本>", "目标版本号")
    .option("--target-date <日期>", "目标日期（YYYY-MM-DD）")
    .action(async (kind: string, title: string, opts: ContainerAddOptions, cmd: Command) => {
      await runContainerAdd(ctx, kind, title, opts, globalAgentFlag(cmd));
    });

  container
    .command("set")
    .description("修改容器，至少要给一个选项")
    .argument("<容器>", "容器编号、misc 或 ID 前缀")
    .option("--status <状态>", `手动状态：${CONTAINER_STATUS_OPTION_HINT}`)
    .option("--reason <原因>", "手动状态的原因（设为 suspended 时必填）")
    .option("--title <标题>", "容器标题")
    .option("--code <编号>", "容器编号，传空字符串清空")
    .option("--version <版本>", "目标版本号，传空字符串清空")
    .option("--target-date <日期>", "目标日期（YYYY-MM-DD），传空字符串清空")
    .action(async (ref: string, opts: ContainerSetOptions, cmd: Command) => {
      await runContainerSet(ctx, ref, opts, globalAgentFlag(cmd));
    });
}
