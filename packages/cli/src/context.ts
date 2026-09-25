import os from "node:os";

/** 只需要一个 write 方法的输出目标，方便测试用内存缓冲区替换 */
export interface Writer {
  write(s: string): void;
}

/**
 * kh 运行所需的一切外部依赖：命令代码只经这个接口接触进程、时间、网络，
 * 不直接用 process.*、Date.now()、全局 fetch，测试因此可以完全用假实现驱动。
 */
export interface CliContext {
  cwd: string;
  env: Record<string, string | undefined>;
  stdout: Writer;
  stderr: Writer;
  /** 交互式确认从这里读一行输入 */
  stdin: NodeJS.ReadableStream;
  isTTY: boolean;
  now(): Date;
  platform: NodeJS.Platform;
  hostname: string;
  /** 当前用户主目录的绝对路径；取不到时为空字符串（resolveKhHome 据此判断） */
  homeDir: string;
  fetch: typeof fetch;
}

/** os.homedir() 在极少数取不到主目录的环境下会抛错，这里退化成空字符串，交给 resolveKhHome 统一报错 */
function safeHomedir(): string {
  try {
    return os.homedir();
  } catch {
    return "";
  }
}

/** 用真实的 process 构造运行上下文；只应该在 bin.ts 里调用一次 */
export function createNodeContext(): CliContext {
  return {
    cwd: process.cwd(),
    env: process.env,
    stdout: { write: (s) => process.stdout.write(s) },
    stderr: { write: (s) => process.stderr.write(s) },
    stdin: process.stdin,
    isTTY: Boolean(process.stdin.isTTY),
    now: () => new Date(),
    platform: process.platform,
    hostname: os.hostname(),
    homeDir: safeHomedir(),
    fetch: globalThis.fetch.bind(globalThis),
  };
}
