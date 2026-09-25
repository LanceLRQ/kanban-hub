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
