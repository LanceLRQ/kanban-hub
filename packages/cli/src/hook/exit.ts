/**
 * hook 命令的出口、时间预算与输出隔离。hook 绝不能阻塞或打扰 agent 会话：
 * - 只有 HookExit 能让 hook 以退出码 2 结束（Stop 的提醒），其余任何失败都写 hook.log、退出码 0；
 * - hook 内部调用的函数照常往 ctx.stdout / ctx.stderr 写警告，hook 给它们一个把这两个流转写进
 *   hook.log 的派生 ctx，只有最后的摘要和提醒写到真实的流。
 */
import type { CliContext, Writer } from "../context";
import { CliError } from "../errors";
import { openHookLog } from "./log";

/** hook 的时间与篇幅预算；写进 settings.json 的 hook 超时是 15 秒，硬性兜底必须落在它之内 */
export const HOOK_LIMITS = {
  /** 读 stdin 最多等这么久（Stop 的输入里带着整段最后回复） */
  stdinTimeoutMs: 2000,
  /** 读 stdin 最多接受这么多字节 */
  stdinMaxBytes: 8 * 1024 * 1024,
  /** 自动拉取的截止时间：hook 开始后这么久不再处理下一个文件 */
  pullDeadlineMs: 8000,
  /** 自动拉取里每个请求的超时 */
  pullRequestTimeoutMs: 2000,
  /** 项目进度请求的超时，与拉取同时发出 */
  detailTimeoutMs: 3000,
  /** 硬性兜底：hook 开始后这么久，不管做到哪一步都放弃等待，退出码 0 */
  hardLimitMs: 13_500,
  /**
   * 后台同步（kh hook sync）的上限：它已经脱离 agent 会话，不受 hook 超时约束，只防挂死；
   * 套用前台的 13.5 秒会让大批文档或慢网络下每一轮都在同一处被截断
   */
  backgroundSyncLimitMs: 300_000,
  /** 进度摘要的行数与字符数上限 */
  summaryMaxLines: 40,
  summaryMaxChars: 4000,
  /** 后台同步：清单没有变化且距上次推送不到这么久时跳过 */
  pushSkipWindowMs: 600_000,
} as const;

/**
 * 用 Symbol.for 品牌识别，不用 instanceof：打包或测试环境里同一份源码可能被加载成多个
 * 模块实例，跨实例的 instanceof 会误判。
 */
const HOOK_EXIT_BRAND = Symbol.for("kanban-hub.hook-exit");

/** hook 子树唯一能返回非 0 退出码的出口：stderr 原样写出，不加“错误：”前缀 */
export class HookExit extends Error {
  readonly [HOOK_EXIT_BRAND] = true;

  constructor(
    readonly exitCode: 0 | 2,
    readonly stderr?: string,
  ) {
    super(`hook 以退出码 ${exitCode} 结束`);
    this.name = "HookExit";
  }
}

export function isHookExit(err: unknown): err is HookExit {
  return typeof err === "object" && err !== null && (err as Record<PropertyKey, unknown>)[HOOK_EXIT_BRAND] === true;
}

/** 把错误整理成一行日志：CliError 带上提示，多行消息压成一行；不含请求头，所以不会带出令牌 */
export function describeHookError(err: unknown): string {
  let text: string;
  if (err instanceof CliError) text = err.hint ? `${err.message}（${err.hint}）` : err.message;
  else if (err instanceof Error) text = err.message;
  else text = String(err);
  return oneLine(text);
}

function oneLine(text: string): string {
  return text.replace(/\r?\n/g, " | ");
}

export interface HookLogger {
  /** hook.log 的路径；KH_HOME 解析不出来时为 null（此时写入一律忽略） */
  path: string | null;
  /** 找到仓库之后调用，之后的每一行都带上项目 ID */
  setProject(projectId: string): void;
  /** 追加一行；按调用顺序落盘，永不抛错 */
  write(message: string): void;
  /** 按行转写的输出目标：给派生 ctx 的 stdout、stderr 用 */
  writer: Writer;
  /** 等已经排队的写入全部落盘（含 writer 里没有换行结尾的残留） */
  flush(): Promise<void>;
}

/** 打开 hook.log 并按顺序写入；event 是 hook 名，写在每一行的时间之后 */
export function createHookLogger(ctx: CliContext, event: string): HookLogger {
  let log: ReturnType<typeof openHookLog> | null;
  try {
    log = openHookLog(ctx);
  } catch {
    log = null;
  }

  let projectId: string | undefined;
  let chain: Promise<void> = Promise.resolve();
  let pending = "";
  const decoder = new TextDecoder();

  const write = (message: string): void => {
    if (log === null) return;
    const target = log;
    const line = oneLine(message);
    const project = projectId;
    chain = chain.then(() => target.write(event, line, project));
  };

  return {
    path: log?.path ?? null,
    setProject: (id) => {
      projectId = id;
    },
    write,
    writer: {
      write: (s) => {
        pending += typeof s === "string" ? s : decoder.decode(s, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) if (line.trim() !== "") write(line);
      },
    },
    flush: async () => {
      if (pending.trim() !== "") write(pending);
      pending = "";
      await chain;
    },
  };
}

/** 派生 ctx：stdout、stderr 都转写进 hook.log，其余能力（时间、网络、后台启动）原样沿用 */
export function quietContext(ctx: CliContext, logger: HookLogger): CliContext {
  return { ...ctx, stdout: logger.writer, stderr: logger.writer };
}

/** 各 hook 流程拿到的运行环境 */
export interface HookRun {
  /** 派生 ctx：内部调用的输出都进 hook.log */
  ctx: CliContext;
  log: HookLogger;
  /** 写到真实的 stdout；硬性兜底触发之后调用会被丢弃 */
  emit(text: string): void;
  /** --agent 的原始值 */
  agentFlag: string | undefined;
  /** hook 开始的时间（毫秒，取自 ctx.now） */
  startedAt: number;
}
