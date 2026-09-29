import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnDetachedNode } from "./hook/spawn";

/**
 * 只需要一个 write 属性的输出目标，方便测试用内存缓冲区替换。
 * 传字节数组时原样写出（例如冲突差异里的文件内容），不经过文本解码。
 * 属性写法（而不是接口方法写法）让参数类型按严格的逆变规则检查：一个只声明
 * 收字符串的 writer 不能被当作能收字节数组的 writer 使用。
 */
export interface Writer {
  write: (s: string | Uint8Array) => void;
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
  /**
   * 以脱离当前进程的方式启动 `node <kh 入口> ...args`，用于 hook 在后台触发同步。
   * 可选：cli 里有多处测试夹具直接构造 CliContext，不逐一补上这个能力；调用方
   * 遇到缺失时应该写日志并跳过，不当作错误处理。
   */
  spawnBackground?(args: string[], opts: { cwd: string; logFile: string }): void;
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
    // 打包后这个文件就在 kh.mjs 里，import.meta.url 就是 kh 自己的入口，不依赖启动方式
    spawnBackground: (args, opts) =>
      spawnDetachedNode(fileURLToPath(import.meta.url), args, { cwd: opts.cwd, env: process.env, logFile: opts.logFile }),
  };
}
