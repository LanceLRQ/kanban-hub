import { Command } from "commander";
import { KH_VERSION } from "@kanban-hub/core";

/** 构建 kh 的命令定义。子命令在后续里程碑中逐步注册到这里。 */
export function buildProgram(): Command {
  return new Command()
    .name("kh")
    .description("kanban-hub 命令行：上报进度、同步文档")
    .version(KH_VERSION, "-v, --version", "显示版本号")
    .helpOption("-h, --help", "显示帮助");
}
