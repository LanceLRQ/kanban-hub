import { Command, CommanderError } from "commander";
import type { CliContext } from "./context";
import { CliError, EXIT } from "./errors";
import { buildProgram } from "./program";

const COMMANDER_ERROR_PREFIX = "error: ";

/** 让 commander 把输出都写到 ctx，并把它自己的“error: ”前缀换成约定的“错误：” */
function attachOutput(program: Command, ctx: CliContext): void {
  program.exitOverride().configureOutput({
    writeOut: (s) => ctx.stdout.write(s),
    writeErr: (s) => ctx.stderr.write(s),
    outputError: (str, write) =>
      write(str.startsWith(COMMANDER_ERROR_PREFIX) ? `错误：${str.slice(COMMANDER_ERROR_PREFIX.length)}` : str),
  });
}

function reportCliError(ctx: CliContext, err: CliError): void {
  ctx.stderr.write(`错误：${err.message}\n`);
  if (err.hint) ctx.stderr.write(`提示：${err.hint}\n`);
}

/**
 * 解析并执行一个已经装配好的 commander program，把各种失败映射成退出码。
 * main() 用它跑真实的 kh 程序；这里单独导出，是为了不依赖具体命令就能测试错误映射
 * （任务 1 阶段 commands/ 下都是占位实现，还没有真正会抛错的命令）。
 */
export async function runProgram(program: Command, argv: string[], ctx: CliContext): Promise<number> {
  attachOutput(program, ctx);
  try {
    await program.parseAsync(argv, { from: "user" });
    return EXIT.OK;
  } catch (err) {
    if (err instanceof CommanderError) {
      // --help / --version 走的是 commander 自己的正常退出（exitCode 0），已经在上面写好输出
      return err.exitCode === 0 ? EXIT.OK : EXIT.USAGE;
    }
    if (err instanceof CliError) {
      reportCliError(ctx, err);
      return err.exitCode;
    }
    ctx.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.UNEXPECTED;
  }
}

/** kh 的入口：装配命令并执行，返回进程退出码；bin.ts 据此设置 process.exitCode */
export async function main(argv: string[], ctx: CliContext): Promise<number> {
  return runProgram(buildProgram(ctx), argv, ctx);
}
