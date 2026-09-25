import type { Command } from "commander";
import type { ProjectDetailResponse } from "@kanban-hub/core/api";
import type { CliContext } from "../context";
import { CliError, EXIT } from "../errors";
import type { ApiClient } from "../http/client";
import { buildStatusView } from "../status/view";
import { renderStatusText, toStatusJson } from "../status/render";
import { globalAgentFlag, loadProject, requireLogin, requireRegisteredRepo } from "./shared";

interface StatusOptions {
  json?: boolean;
}

/**
 * loadProject 在项目找不到时按“退出码的归属”抛 CliError(5)，但那条消息只是服务端给的
 * “未找到”，看不出问题出在哪。status 是唯一直接把 config.yaml 里的 projectId 交给
 * loadProject 的命令，这里补一条提示：多半是仓库配置里的 projectId 不对（简报的测试点要求）。
 */
async function loadProjectOrFail(client: ApiClient, projectId: string): Promise<ProjectDetailResponse> {
  try {
    return await loadProject(client, projectId);
  } catch (err) {
    if (err instanceof CliError && err.exitCode === EXIT.DATA) {
      throw new CliError(err.exitCode, err.message, err.hint ?? "请检查仓库配置 .kanban-hub/config.yaml 里的 projectId 是否正确");
    }
    throw err;
  }
}

async function runStatus(ctx: CliContext, opts: StatusOptions, agentFlag?: string): Promise<void> {
  const repo = await requireRegisteredRepo(ctx);
  const { client, machine } = await requireLogin(ctx, agentFlag);
  const detail = await loadProjectOrFail(client, repo.config.projectId);
  const view = buildStatusView(detail, { machineId: machine.id, now: ctx.now() });

  if (opts.json) {
    ctx.stdout.write(`${JSON.stringify(toStatusJson(view), null, 2)}\n`);
  } else {
    ctx.stdout.write(renderStatusText(view));
  }
}

/** kh status：给人和 AI 看的项目进度，不写上报时间，也不写任何文件（简报“不需要写”） */
export function registerStatus(program: Command, ctx: CliContext): void {
  program
    .command("status")
    .description("显示当前仓库对应项目的进度")
    .option("--json", "以 JSON 格式输出，供脚本使用")
    .action(async (opts: StatusOptions, cmd: Command) => {
      await runStatus(ctx, opts, globalAgentFlag(cmd));
    });
}
