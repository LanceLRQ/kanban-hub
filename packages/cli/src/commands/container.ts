import type { Command } from "commander";
import { formatZodError } from "@kanban-hub/core/errors";
import { shortIdPrefixes } from "@kanban-hub/core/ids";
import {
  containerCreateInput,
  containerPatchInput,
  containerSchema,
  MANUAL_STATUSES,
  type ManualStatus,
} from "@kanban-hub/core/schema";
import type { CliContext } from "../context";
import { CliError, EXIT } from "../errors";
import { MANUAL_STATUS_LABELS } from "./labels";
import {
  afterReport,
  assertAnyOptionGiven,
  containerRefLabel,
  displayEmpty,
  formatChange,
  globalAgentFlag,
  loadProject,
  parseEnumOption,
  parseNullableDateOption,
  parseNullableOption,
  requireLogin,
  requireRegisteredRepo,
  resolveContainerOrFail,
  withAgentOption,
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

/** container 的目标日期选项：清空/格式校验逻辑与 task 的截止日期共用，见 shared.ts 的 parseNullableDateOption */
export const parseTargetDateOption = parseNullableDateOption;

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
  assertAnyOptionGiven(
    [
      opts.status !== undefined,
      opts.reason !== undefined,
      opts.title !== undefined,
      opts.code !== undefined,
      opts.version !== undefined,
      opts.targetDate !== undefined,
    ],
    "可选：--status、--reason、--title、--code、--version、--target-date",
  );

  const patch: Record<string, unknown> = {};

  if (opts.status !== undefined) {
    const statusOption = parseEnumOption(opts.status, CONTAINER_STATUS_VALUES, CONTAINER_STATUS_LABELS);
    const manualStatus = statusOption === "auto" ? null : statusOption;
    // 原因为空（不给 --reason，或者给了空字符串）都在本地拦下，不让服务端的 400 顶上来
    if (manualStatus === "suspended" && (opts.reason === undefined || opts.reason === "")) {
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

/**
 * container add 成功后的提示行：有编号时编号与短 ID 前缀之间用空格分隔；
 * 没有编号时不显示 displayEmpty 的“（无）”，直接是短 ID 前缀，与 containerRefLabel 的口径一致。
 */
export function formatContainerAddedMessage(
  kind: ContainerAddKind,
  code: string | null,
  prefix: string,
  title: string,
): string {
  const label = code !== null ? `${code}（${prefix}）` : `（${prefix}）`;
  return `已新建${CONTAINER_KIND_LABELS[kind]}容器${code !== null ? " " : ""}${label}：${title}`;
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

  ctx.stdout.write(`${formatContainerAddedMessage(kind, created.code, prefix, created.title)}\n`);
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
    changes.push(formatChange("状态", manualStatusLabel(before.manualStatus), manualStatusLabel(updated.manualStatus)));
  }
  if (opts.reason !== undefined) changes.push(formatChange("原因", displayEmpty(before.manualReason), displayEmpty(updated.manualReason)));
  if (opts.title !== undefined) changes.push(formatChange("标题", before.title, updated.title));
  if (opts.code !== undefined) changes.push(formatChange("编号", displayEmpty(before.code), displayEmpty(updated.code)));
  if (opts.version !== undefined) changes.push(formatChange("版本", displayEmpty(before.targetVersion), displayEmpty(updated.targetVersion)));
  if (opts.targetDate !== undefined) changes.push(formatChange("目标日期", displayEmpty(before.targetDate), displayEmpty(updated.targetDate)));

  // 杂项容器没有编号时不再输出完整的 10 位 ID：有编号用编号，杂项用 misc，否则用 ID 前缀
  const refLabel = containerRefLabel(before, project.board.containers);
  ctx.stdout.write(`已更新容器 ${refLabel}：${changes.join("；")}\n`);
  await afterReport(ctx, repo.config.projectId);
}

/** kh container add / set：新建、修改阶段 / 特性 / 杂项容器（规格 10.2） */
export function registerContainer(program: Command, ctx: CliContext): void {
  const container = program.command("container").description("容器相关命令");

  withAgentOption(
    container
      .command("add")
      .description("新建阶段或特性容器")
      .argument("<种类>", "phase（阶段）或 feature（特性）")
      .argument("<标题>", "容器标题")
      .option("--code <编号>", "容器编号")
      .option("--version <版本>", "目标版本号")
      .option("--target-date <日期>", "目标日期（YYYY-MM-DD）"),
  ).action(async (kind: string, title: string, opts: ContainerAddOptions, cmd: Command) => {
    await runContainerAdd(ctx, kind, title, opts, globalAgentFlag(cmd));
  });

  withAgentOption(
    container
      .command("set")
      .description("修改容器，至少要给一个选项")
      .argument("<容器>", "容器编号、misc 或 ID 前缀")
      .option("--status <状态>", `手动状态：${CONTAINER_STATUS_OPTION_HINT}`)
      .option("--reason <原因>", "手动状态的原因（设为 suspended 时必填）")
      .option("--title <标题>", "容器标题")
      .option("--code <编号>", "容器编号，传空字符串清空")
      .option("--version <版本>", "目标版本号，传空字符串清空")
      .option("--target-date <日期>", "目标日期（YYYY-MM-DD），传空字符串清空"),
  ).action(async (ref: string, opts: ContainerSetOptions, cmd: Command) => {
    await runContainerSet(ctx, ref, opts, globalAgentFlag(cmd));
  });
}
