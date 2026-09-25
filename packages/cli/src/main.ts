import { Command, CommanderError } from "commander";
import type { CliContext } from "./context";
import { CliError, EXIT } from "./errors";
import { buildProgram } from "./program";

const COMMANDER_ERROR_PREFIX = "error: ";

/**
 * commander 内置的几类常见错误固定用英文拼好整句消息，出错时不带错误码地传给 outputError，
 * 只能按消息的既定格式匹配着翻译（见 node_modules/commander/lib/command.js 的
 * missingArgument / optionMissingArgument / missingMandatoryOptionValue / unknownOption /
 * unknownCommand / _excessArguments / _conflictingOption）。这里只翻译这几种已知格式，
 * 匹配不上的（包括各选项自定义校验函数抛出的 InvalidArgumentError）原样保留英文。
 */
const COMMANDER_MESSAGE_TRANSLATIONS: readonly {
  pattern: RegExp;
  translate: (m: RegExpMatchArray) => string;
}[] = [
  { pattern: /^missing required argument '(.+)'$/, translate: (m) => `缺少必需的参数 '${m[1]}'` },
  { pattern: /^option '(.+)' argument missing$/, translate: (m) => `选项 '${m[1]}' 缺少参数值` },
  { pattern: /^required option '(.+)' not specified$/, translate: (m) => `缺少必需的选项 '${m[1]}'` },
  { pattern: /^unknown option '([^']+)'([\s\S]*)$/, translate: (m) => `未知选项 '${m[1]}'${m[2]}` },
  { pattern: /^unknown command '([^']+)'([\s\S]*)$/, translate: (m) => `未知命令 '${m[1]}'${m[2]}` },
  {
    pattern: /^too many arguments(?: for '(.+?)')?\. Expected (\d+) arguments? but got (\d+): ([\s\S]*)\.$/,
    translate: (m) => `参数太多${m[1] ? `（命令 '${m[1]}'）` : ""}：预期 ${m[2]} 个，实际收到 ${m[3]} 个：${m[4]}`,
  },
  {
    pattern: /^((?:option|environment variable) '.+?') cannot be used with ((?:option|environment variable) '.+?')$/,
    translate: (m) => `${m[1]} 不能和 ${m[2]} 同时使用`,
  },
];

/** 按已知格式翻译一条 commander 错误消息（不含末尾换行）；匹配不上时原样返回 */
function translateCommanderMessage(message: string): string {
  for (const { pattern, translate } of COMMANDER_MESSAGE_TRANSLATIONS) {
    const match = pattern.exec(message);
    if (match) return translate(match);
  }
  return message;
}

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
    outputError: (str, write) => {
      if (!str.startsWith(COMMANDER_ERROR_PREFIX)) {
        write(str);
        return;
      }
      const rest = str.slice(COMMANDER_ERROR_PREFIX.length);
      const hasTrailingNewline = rest.endsWith("\n");
      const body = hasTrailingNewline ? rest.slice(0, -1) : rest;
      write(`错误：${translateCommanderMessage(body)}${hasTrailingNewline ? "\n" : ""}`);
    },
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
