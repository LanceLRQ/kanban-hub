import type { Command } from "commander";
import type { CliContext } from "../context";
import { buildStatusView } from "../status/view";
import { renderStatusText, toStatusJson } from "../status/render";
import { globalAgentFlag, loadProjectOrFail, requireLogin, requireRegisteredRepo, withAgentOption } from "./shared";

interface StatusOptions {
  json?: boolean;
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

/** kh status：给人和 AI 看的项目进度，是只读命令：不写上报时间，也不写任何本地文件 */
export function registerStatus(program: Command, ctx: CliContext): void {
  withAgentOption(
    program.command("status").description("显示当前仓库对应项目的进度").option("--json", "以 JSON 格式输出，供脚本使用"),
  ).action(async (opts: StatusOptions, cmd: Command) => {
    await runStatus(ctx, opts, globalAgentFlag(cmd));
  });
}
