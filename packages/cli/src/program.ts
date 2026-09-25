import { Command } from "commander";
import { KH_VERSION } from "@kanban-hub/core/version";
import { registerAuth } from "./commands/auth";
import { registerContainer } from "./commands/container";
import { registerLog } from "./commands/log";
import { registerProject } from "./commands/project";
import { registerRegister } from "./commands/register";
import { registerStatus } from "./commands/status";
import { registerTask } from "./commands/task";
import type { CliContext } from "./context";

/** 构建 kh 的命令定义：根命令加全局 --agent，再把各命令模块接进来 */
export function buildProgram(ctx: CliContext): Command {
  const program = new Command()
    .name("kh")
    .description("kanban-hub 命令行：上报进度、同步文档")
    .version(KH_VERSION, "-v, --version", "显示版本号")
    .helpOption("-h, --help", "显示帮助")
    .option("--agent <名称>", "标注上报事件的 agent 名称，不指定时按运行环境自动识别");

  registerAuth(program, ctx);
  registerRegister(program, ctx);
  registerStatus(program, ctx);
  registerProject(program, ctx);
  registerContainer(program, ctx);
  registerTask(program, ctx);
  registerLog(program, ctx);

  return program;
}
