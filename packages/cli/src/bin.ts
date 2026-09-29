import { createNodeContext } from "./context";
import { installHookSafetyNet } from "./hook/exit";
import { isHookArgv, main } from "./main";

/** 等 stdout、stderr 里已经写出的内容交给操作系统；最多等 1 秒，管道对端不读时不能卡住 */
function drain(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 1000);
    stream.write("", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

const argv = process.argv.slice(2);
const hookMode = isHookArgv(argv);
const ctx = createNodeContext();
/** hook 命令得出的退出码；兜底处理在命令结束之后才触发时沿用它（例如 Stop 的提醒已经写出） */
let hookExitCode = 0;
if (hookMode) {
  // 管道对端已经关闭（EPIPE）时，没有监听器的 'error' 会让进程以退出码 1 崩溃并打印堆栈；
  // hook 必须按自己的退出码结束，写不出去的内容直接丢弃
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});
  installHookSafetyNet(process, ctx, { exitCode: () => hookExitCode, exit: (c) => process.exit(c) });
}

const code = await main(argv, ctx);
if (hookMode) {
  hookExitCode = code;
  // hook 结束后显式结束进程：残留的请求、没关闭的 stdin、硬性兜底之后仍在跑的流程都不能拖住它
  await Promise.all([drain(process.stdout), drain(process.stderr)]);
  process.exit(code);
}
process.exitCode = code;
