import type { Command } from "commander";
import type { CliContext } from "../context";
import { partialPullResultOf, pullDocs, renderPullResult, type PullResult } from "../sync/pull";
import { globalAgentFlag, requireLogin, requireRegisteredRepo, withAgentOption } from "./shared";

interface PullCommandOptions {
  from?: string;
  path?: string;
  dryRun?: boolean;
}

async function runPull(ctx: CliContext, opts: PullCommandOptions, agentFlag: string | undefined): Promise<void> {
  const repo = await requireRegisteredRepo(ctx);
  const { client } = await requireLogin(ctx, agentFlag);
  const dryRun = Boolean(opts.dryRun);
  let result: PullResult;
  try {
    result = await pullDocs(ctx, repo, client, {
      ...(opts.from !== undefined ? { from: opts.from } : {}),
      ...(opts.path !== undefined ? { pathGlob: opts.path } : {}),
      dryRun,
    });
  } catch (err) {
    // 中途出错：先把出错之前已完成的部分列出来，再按原错误报错退出
    const partial = partialPullResultOf(err);
    if (partial !== null) ctx.stdout.write(renderPullResult(partial, dryRun, true));
    throw err;
  }
  ctx.stdout.write(renderPullResult(result, dryRun));
}

/** kh pull：把其他机器的文档版本按逐文件规则拉到本地（规格 9.3） */
export function registerPull(program: Command, ctx: CliContext): void {
  withAgentOption(
    program
      .command("pull")
      .description("把其他机器同步的文档拉到本地：新建、覆盖、自动合并，合不了的登记为冲突")
      .option("--from <机器>", "只看某一台机器（机器名或 ID 前缀），省略时每个路径取其他机器里最新的版本")
      .option("--path <glob>", "只处理匹配的路径")
      .option("--dry-run", "只列出将要做的事，不写任何东西"),
  ).action(async (opts: PullCommandOptions, cmd: Command) => {
    await runPull(ctx, opts, globalAgentFlag(cmd));
  });
}
