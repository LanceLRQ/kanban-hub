import { Command } from "commander";
import type { CliContext } from "../context";
import { confirm } from "../prompt";
import { applySetup, planSetup, renderSetupPlan, type SetupPlan } from "../setup/plan";

interface SetupOptions {
  dryRun?: boolean;
  yes?: boolean;
  uninstall?: boolean;
}

/** 打印计划；--dry-run 到此为止，否则按 --yes 或交互确认决定是否继续执行 */
async function confirmPlan(ctx: CliContext, opts: SetupOptions): Promise<boolean> {
  if (opts.dryRun) return false;
  if (opts.yes) return true;
  const proceed = await confirm(ctx, "是否执行以上计划？");
  if (!proceed) ctx.stdout.write("已取消。\n");
  return proceed;
}

function printOutcome(ctx: CliContext, plan: SetupPlan): void {
  ctx.stdout.write(plan.uninstall ? "已卸载。\n" : "已完成，hook 在新开的 Claude Code 会话里生效。\n");
  ctx.stdout.write(
    "hook 依赖 PATH 里的 kh：从图形界面启动的 Claude Code 可能找不到它；装着多个版本时，请在 Claude Code 里执行 kh --version 确认与命令行里执行的是同一个版本，旧版本没有 hook 命令会被当成用法错误。\n",
  );
  if (!plan.loggedIn) {
    ctx.stdout.write("本机还没有登录，hook 运行时不会做任何事，请先执行 kh login。\n");
  }
}

async function runSetup(ctx: CliContext, opts: SetupOptions): Promise<void> {
  const plan = await planSetup(ctx, { uninstall: Boolean(opts.uninstall) });
  ctx.stdout.write(`${renderSetupPlan(plan)}\n`);

  const proceed = await confirmPlan(ctx, opts);
  if (!proceed) return;

  await applySetup(ctx, plan);
  printOutcome(ctx, plan);
}

/** kh setup：装好（或卸掉）通用 skill 与 Claude Code 的 skill、hook（规格 12.1） */
export function registerSetup(program: Command, ctx: CliContext): void {
  program
    .command("setup")
    .description("安装或卸载 kanban-hub 的 AI 接入 skill 与 Claude Code hook")
    .option("--dry-run", "只打印计划，不写入任何内容")
    .option("--yes", "跳过交互确认")
    .option("--uninstall", "卸载 skill 与 hook")
    .action(async (opts: SetupOptions) => {
      await runSetup(ctx, opts);
    });
}
