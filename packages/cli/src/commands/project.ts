import type { Command } from "commander";
import { formatZodError } from "@kanban-hub/core/errors";
import { CYCLES, HEALTHS, projectPatchInput, projectSchema } from "@kanban-hub/core/schema";
import type { CliContext } from "../context";
import { CliError, EXIT } from "../errors";
import { CYCLE_LABELS, HEALTH_LABELS } from "./labels";
import {
  afterReport,
  assertAnyOptionGiven,
  displayEmpty,
  formatChange,
  globalAgentFlag,
  loadProject,
  parseEnumOption,
  requireLogin,
  requireRegisteredRepo,
  withAgentOption,
} from "./shared";

export interface ProjectSetOptions {
  cycle?: string;
  health?: string;
  focus?: string;
}

const CYCLE_OPTION_HINT = CYCLES.map((c) => `${c}（${CYCLE_LABELS[c]}）`).join("、");
const HEALTH_OPTION_HINT = HEALTHS.map((h) => `${h}（${HEALTH_LABELS[h]}）`).join("、");

/**
 * 校验 project set 的选项并整理成请求体：至少要给一个选项，否则用法错误；
 * --cycle / --health 的取值先在本地按枚举校验（不合法时列出可选值），--focus 原样透传
 * （可以是空字符串，用来清空当前焦点）。抽成纯函数方便单元测试，不涉及网络。
 */
export function buildProjectPatch(opts: ProjectSetOptions) {
  assertAnyOptionGiven(
    [opts.cycle !== undefined, opts.health !== undefined, opts.focus !== undefined],
    "可选：--cycle、--health、--focus",
  );

  const patch: Record<string, unknown> = {};
  if (opts.cycle !== undefined) patch.cycle = parseEnumOption(opts.cycle, CYCLES, CYCLE_LABELS);
  if (opts.health !== undefined) patch.health = parseEnumOption(opts.health, HEALTHS, HEALTH_LABELS);
  if (opts.focus !== undefined) patch.focus = opts.focus;

  const parsed = projectPatchInput.safeParse(patch);
  if (!parsed.success) throw new CliError(EXIT.USAGE, formatZodError(parsed.error).join("；"));
  return parsed.data;
}

async function runProjectSet(ctx: CliContext, opts: ProjectSetOptions, agentFlag: string | undefined): Promise<void> {
  const patch = buildProjectPatch(opts);

  const repo = await requireRegisteredRepo(ctx);
  const { client } = await requireLogin(ctx, agentFlag);
  const before = await loadProject(client, repo.config.projectId);
  const updated = await client.patch(`/api/v1/projects/${repo.config.projectId}`, patch, projectSchema);

  const changes: string[] = [];
  if (opts.cycle !== undefined) changes.push(formatChange("周期", CYCLE_LABELS[before.project.cycle], CYCLE_LABELS[updated.cycle]));
  if (opts.health !== undefined) changes.push(formatChange("健康度", HEALTH_LABELS[before.project.health], HEALTH_LABELS[updated.health]));
  if (opts.focus !== undefined) changes.push(formatChange("焦点", displayEmpty(before.project.focus), displayEmpty(updated.focus)));

  ctx.stdout.write(`已更新项目：${changes.join("；")}\n`);
  await afterReport(ctx, repo.config.projectId);
}

/** kh project set：修改项目的周期、健康度或当前焦点（规格 10.2） */
export function registerProject(program: Command, ctx: CliContext): void {
  const project = program.command("project").description("项目相关命令");

  withAgentOption(
    project
      .command("set")
      .description("修改项目的周期、健康度或当前焦点，至少要给一个选项")
      .option("--cycle <周期>", `项目周期：${CYCLE_OPTION_HINT}`)
      .option("--health <健康度>", `健康度：${HEALTH_OPTION_HINT}`)
      .option("--focus <焦点>", "当前焦点，传空字符串清空"),
  ).action(async (opts: ProjectSetOptions, cmd: Command) => {
    await runProjectSet(ctx, opts, globalAgentFlag(cmd));
  });
}
