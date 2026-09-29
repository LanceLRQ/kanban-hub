import readline from "node:readline";
import { Writable, type Readable } from "node:stream";
import type { CliContext } from "./context";
import { CliError, EXIT } from "./errors";

/** 从可读流里读一行（到第一个 \n 为止，或者流结束）；不依赖 readline，方便用普通流当测试桩 */
function readLine(stdin: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";

    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      stdin.removeListener("error", onError);
    };
    const onData = (chunk: Buffer | string) => {
      buffer += String(chunk);
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex >= 0) {
        cleanup();
        stdin.pause();
        resolve(buffer.slice(0, newlineIndex));
      }
    };
    const onEnd = () => {
      cleanup();
      resolve(buffer);
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    stdin.on("data", onData);
    stdin.on("end", onEnd);
    stdin.on("error", onError);
    stdin.resume();
  });
}

/**
 * 交互式确认。非交互环境（没有 TTY，读不到键盘输入）直接抛用法错误，提示加 --yes 跳过；
 * 交互时只有输入 y 或 yes（不分大小写）才算确认。
 */
export async function confirm(ctx: CliContext, question: string): Promise<boolean> {
  if (!ctx.isTTY) {
    throw new CliError(EXIT.USAGE, "当前不是交互式终端，无法确认", "加上 --yes 跳过确认");
  }
  ctx.stdout.write(`${question} (y/N) `);
  const answer = (await readLine(ctx.stdin)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

/** 丢弃一切写入的输出：readline 的行编辑会把输入回显写进 output，密码不能落到真实终端 */
const SILENT_OUTPUT = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});

/**
 * 交互式读一行密码。readline 用终端（行编辑）模式打开：它会把终端切进原始模式（TTY 驱动
 * 不再回显），自己把回显写进上面这个丢弃的 output，真实终端上看不到输入内容；
 * historySize 0 让密码不进 readline 的上下键历史。没有交互终端（管道、脚本）时抛用法
 * 错误（2）——密码只能从终端读，不提供命令行参数，避免进 shell 历史与进程列表。
 * 输入流提前结束（Ctrl+D）同样按用法错误处理：空密码只能用直接回车表达，不能让 Ctrl+D
 * 悄悄变成“不加密”。
 */
export async function readPassword(ctx: CliContext, prompt: string): Promise<string> {
  if (!ctx.isTTY) {
    throw new CliError(EXIT.USAGE, "读取密码需要交互式终端", "请在终端里直接运行这条命令");
  }
  ctx.stdout.write(prompt);
  // CliContext 只声明 ReadableStream 接口，运行时一定是 Node 的 Readable（bin.ts 用 process.stdin）
  const rl = readline.createInterface({
    input: ctx.stdin as Readable,
    output: SILENT_OUTPUT,
    terminal: true,
    historySize: 0,
  });
  try {
    return await new Promise<string>((resolve, reject) => {
      rl.once("close", () => reject(new CliError(EXIT.USAGE, "输入已结束，没有读到密码")));
      // raw 模式下 Ctrl+C 由 readline 合成 SIGINT 事件：没有监听器时它只暂停输入流，
      // question 既不结束、进程也不退出，命令会挂住、终端还停在原始模式。监听它并按
      // “已取消”结束（2，与 kh 其余交互取消同一退出码）
      rl.on("SIGINT", () => reject(new CliError(EXIT.USAGE, "已取消，没有设置密码")));
      rl.question("", resolve);
    });
  } finally {
    // 提交或出错都关掉行编辑：readline 会顺手把终端恢复出原始模式
    rl.close();
  }
}
