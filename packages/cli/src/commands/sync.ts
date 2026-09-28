import type { Command } from "commander";
import type { CliContext } from "../context";
import { pushDocs } from "../sync/push";
import { globalAgentFlag, requireLogin, requireRegisteredRepo, withAgentOption } from "./shared";

interface SyncOptions {
  quiet?: boolean;
}

async function runSync(ctx: CliContext, opts: SyncOptions, agentFlag: string | undefined): Promise<void> {
  const repo = await requireRegisteredRepo(ctx);
  const { client } = await requireLogin(ctx, agentFlag);
  await pushDocs(ctx, repo, client, { quiet: Boolean(opts.quiet) });
}

/** kh sync：把本机同步范围内的文档推送到 kanban-hub（规格第 9 节） */
export function registerSync(program: Command, ctx: CliContext): void {
  withAgentOption(
    program.command("sync").description("把本机同步范围内的文档推送到 kanban-hub").option("--quiet", "成功时不输出内容"),
  ).action(async (opts: SyncOptions, cmd: Command) => {
    await runSync(ctx, opts, globalAgentFlag(cmd));
  });
}
