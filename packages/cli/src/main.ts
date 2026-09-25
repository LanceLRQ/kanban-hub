import { Command, CommanderError } from "commander";
import type { CliContext } from "./context";
import { CliError, EXIT } from "./errors";
import { buildProgram } from "./program";

const COMMANDER_ERROR_PREFIX = "error: ";

/**
 * 让 commander 把输出都写到 ctx，并把它自己的“error: ”前缀换成约定的“错误：”。
 *
 * commander 15 的 `.command()` 在创建子命令的那一刻，用 `copyInheritedSettings()`
 * 把父命令当时的 `_outputConfiguration`/`_exitCallback` 复制一份给子命令（`lib/command.js`
 * 的 `command()`：`cmd.copyInheritedSettings(this)`），之后父命令再调用
 * `exitOverride()`/`configureOutput()` 只是把父命令自己的这两个字段重新赋值成新对象，
 * 不会回头更新已经复制过的子命令——`copyInheritedSettings` 是一次性快照，不是引用联动。
 * 所以“先 buildProgram(ctx) 注册好所有子命令，再对根命令调用一次 attachOutput”这种顺序，
 * 子命令、孙命令永远还停在 commander 的默认行为上（真的调用 process.exit，英文 error: 前缀）。
 *
 * 这里改成对整棵命令树递归设置：因为 runProgram 拿到的 program 在调用这个函数之前已经
 * 完整装配好了（buildProgram(ctx) 已经跑完，测试里手工拼的命令树也已经建好），用
 * `command.commands` 把每一层都走一遍，就不用要求“谁在装配命令树时必须先调用一次
 * exitOverride”这种容易被后续任务遗忘的调用顺序约定。
 */
function attachOutput(command: Command, ctx: CliContext): void {
  command.exitOverride().configureOutput({
    writeOut: (s) => ctx.stdout.write(s),
    writeErr: (s) => ctx.stderr.write(s),
    outputError: (str, write) =>
      write(str.startsWith(COMMANDER_ERROR_PREFIX) ? `错误：${str.slice(COMMANDER_ERROR_PREFIX.length)}` : str),
  });
  for (const sub of command.commands) attachOutput(sub, ctx);
}

function reportCliError(ctx: CliContext, err: CliError): void {
  ctx.stderr.write(`错误：${err.message}\n`);
  if (err.hint) ctx.stderr.write(`提示：${err.hint}\n`);
}

/**
 * 解析并执行一个已经装配好的 commander program（根命令、子命令、孙命令都算），
 * 把各种失败映射成退出码。main() 用它跑真实的 kh 程序；单独导出是为了能用一棵
 * 测试专用的命令树验证错误映射，不用依赖某个具体命令的真实实现。
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
