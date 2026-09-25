import type { Command } from "commander";
import { formatZodError } from "@kanban-hub/core/errors";
import { eventSchema, logInput } from "@kanban-hub/core/schema";
import type { CliContext } from "../context";
import { CliError, EXIT } from "../errors";
import { afterReport, globalAgentFlag, requireLogin, requireRegisteredRepo } from "./shared";

/** 校验 log 的正文并整理成请求体；正文为空（或全是空白）时是用法错误。抽成纯函数方便单元测试 */
export function buildLogInput(text: string) {
  const parsed = logInput.safeParse({ text });
  if (!parsed.success) throw new CliError(EXIT.USAGE, formatZodError(parsed.error).join("；"));
  return parsed.data;
}

async function runLog(ctx: CliContext, text: string, agentFlag: string | undefined): Promise<void> {
  const data = buildLogInput(text);

  const repo = await requireRegisteredRepo(ctx);
  const { client } = await requireLogin(ctx, agentFlag);
  await client.post(`/api/v1/projects/${repo.config.projectId}/log`, data, eventSchema);

  ctx.stdout.write("已记录日志\n");
  await afterReport(ctx, repo.config.projectId);
}

/** kh log：往项目的时间线追加一条日志（规格 10.2） */
export function registerLog(program: Command, ctx: CliContext): void {
  program
    .command("log")
    .description("往项目的时间线追加一条日志")
    .argument("<正文>", "日志正文")
    .action(async (text: string, _opts: unknown, cmd: Command) => {
      await runLog(ctx, text, globalAgentFlag(cmd));
    });
}
