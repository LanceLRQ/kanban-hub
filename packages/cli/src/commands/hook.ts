import type { Command } from "commander";
import type { CliContext } from "../context";
import { runBackgroundSync } from "../hook/background-sync";
import { createHookLogger, describeHookError, HOOK_LIMITS, isHookExit, quietContext, type HookRun } from "../hook/exit";
import { runSessionStartHook } from "../hook/session-start";
import { runStopHook } from "../hook/stop";
import { globalAgentFlag, withAgentOption } from "./shared";

export type HookName = "session-start" | "stop" | "sync";

const FLOWS: Record<HookName, (run: HookRun) => Promise<void>> = {
  "session-start": runSessionStartHook,
  stop: runStopHook,
  sync: runBackgroundSync,
};

export interface HookCommandOptions {
  /** 前台 hook（session-start、stop）的硬性兜底时长，默认 13.5 秒；测试用它缩短 */
  hardLimitMs?: number;
  /** 后台同步（sync）的上限，默认 5 分钟；测试用它缩短 */
  backgroundSyncLimitMs?: number;
}

/** 前台 hook 守住 agent 的 hook 超时；后台同步已脱离会话，只设一个防挂死的上限 */
function timeLimitOf(name: HookName, opts: HookCommandOptions): number {
  return name === "sync"
    ? (opts.backgroundSyncLimitMs ?? HOOK_LIMITS.backgroundSyncLimitMs)
    : (opts.hardLimitMs ?? HOOK_LIMITS.hardLimitMs);
}

/**
 * 三个 hook 共用的外壳：
 * - 流程拿到的是派生 ctx，内部调用的输出都进 hook.log；只有 emit 的摘要写到真实的 stdout；
 * - 流程与计时器赛跑（前台 13.5 秒，后台同步 5 分钟），计时器先到就放弃等待（之后的 emit 一律丢弃），正常结束；
 * - 任何异常都写日志、正常结束；只有 HookExit（Stop 的提醒）原样抛给命令入口。
 * 残留的请求、子进程交给 bin.ts 在命令结束后统一结束进程。
 */
export async function runHookCommand(
  ctx: CliContext,
  name: HookName,
  agentFlag: string | undefined,
  opts: HookCommandOptions = {},
): Promise<void> {
  const log = createHookLogger(ctx, name);
  let open = true;
  let exiting = false;
  const run: HookRun = {
    ctx: quietContext(ctx, log),
    log,
    emit: (text) => {
      if (open) ctx.stdout.write(text);
    },
    agentFlag,
    startedAt: ctx.now().getTime(),
    beginExit: () => {
      if (open) exiting = true;
      return open;
    },
  };

  const hardLimitMs = timeLimitOf(name, opts);
  let timer: ReturnType<typeof setTimeout> | undefined;
  // 计时器不 unref：流程卡在一个不占事件循环的 promise 上时，也要靠它让命令按时结束
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      if (!exiting) {
        open = false;
        resolve("timeout");
        return;
      }
      // 流程已经在输出提醒前的最后一步：再给它一小段时间，免得会话被标为已提醒、提醒却没输出
      timer = setTimeout(() => {
        open = false;
        resolve("timeout");
      }, HOOK_LIMITS.exitGraceMs);
    }, hardLimitMs);
  });

  let exit: unknown = null;
  try {
    const outcome = await Promise.race([FLOWS[name](run).then(() => "done" as const), deadline]);
    if (outcome === "timeout") log.write(`超过 ${hardLimitMs} 毫秒仍未结束，放弃等待`);
  } catch (err) {
    if (isHookExit(err)) exit = err;
    else log.write(`失败：${describeHookError(err)}`);
  } finally {
    open = false;
    clearTimeout(timer);
    await log.flush();
  }
  if (exit !== null) throw exit;
}

const AGENT_NOTE = "供 agent 的 hook 调用，任何失败都不输出、退出码 0，详情见 KH_HOME/logs/hook.log";

/** kh hook：Claude Code 等 agent 的 hook 入口（规格 12.3）；sync 是 Stop 在后台启动的内部命令，不在帮助里列出 */
export function registerHook(program: Command, ctx: CliContext): void {
  const hook = program.command("hook").description(`会话 hook：${AGENT_NOTE}`);

  withAgentOption(hook.command("session-start").description("会话开始：自动拉取文档，输出进度摘要")).action(
    async (_opts: unknown, cmd: Command) => {
      await runHookCommand(ctx, "session-start", globalAgentFlag(cmd));
    },
  );

  withAgentOption(hook.command("stop").description("每轮结束：后台推送文档，改了仓库却没上报时提醒一次")).action(
    async (_opts: unknown, cmd: Command) => {
      await runHookCommand(ctx, "stop", globalAgentFlag(cmd));
    },
  );

  withAgentOption(hook.command("sync", { hidden: true }).description("后台推送文档（内部使用）")).action(
    async (_opts: unknown, cmd: Command) => {
      await runHookCommand(ctx, "sync", globalAgentFlag(cmd));
    },
  );
}
