import type { Command } from "commander";
import { projectDetailResponse, type ProjectDetailResponse } from "@kanban-hub/core/api";
import { shortIdPrefixes } from "@kanban-hub/core/ids";
import { resolveContainerRef, resolveTaskRef, type RefResult } from "@kanban-hub/core/refs";
import type { Board, Container, Task } from "@kanban-hub/core/schema";
import { resolveAgent } from "../agent";
import type { CliContext } from "../context";
import { CliError, EXIT } from "../errors";
import { readMachineConfig, readToken, resolveKhHome } from "../config/home";
import { ApiClient } from "../http/client";
import { recordReport } from "../report-log";
import { findRegisteredRepo, type RegisteredRepo } from "../repo/root";

const LOGIN_HINT = "kh login --server <地址> --code <配对码>";
const REGISTER_HINT = "kh register";

export interface LoggedIn {
  client: ApiClient;
  machine: { id: string; name: string };
  server: string;
}

/**
 * 从子命令读取全局 --agent 的原始值（用 commander 15 的 optsWithGlobals() 沿父链合并选项）。
 * agent 的识别（--agent 优先，其次按环境变量对照表）统一收在 requireLogin 里，调用方只需要把
 * 这个原始值转交过去，不用（也不应该）自己再调 resolveAgent——写命令一旦漏掉这一步，或者只传了
 * --agent 没有回退到环境变量，上报的事件就会丢失 CLAUDECODE 这类自动识别。
 */
export function globalAgentFlag(cmd: Command): string | undefined {
  const value = (cmd.optsWithGlobals() as { agent?: unknown }).agent;
  return typeof value === "string" ? value : undefined;
}

/**
 * 要求本机已经登录：没有本机配置、没有配对过（缺 machineId/machineName）、或凭据文件缺失，
 * 都当作未登录处理（CliError(3)），提示重新执行 kh login。
 * agentFlag 是 --agent 的原始值（用 globalAgentFlag(cmd) 取得），这里统一调 resolveAgent 解析
 * 成最终 agent（超过 50 字符是用法错误），再交给 ApiClient；login/whoami 也走这条路径，保证
 * 所有会发请求的命令都用同一套逻辑决定 X-KH-Agent，不会有的传了 --agent、有的漏了环境变量。
 */
export async function requireLogin(ctx: CliContext, agentFlag?: string): Promise<LoggedIn> {
  const home = resolveKhHome(ctx);
  const cfg = await readMachineConfig(home);
  const token = await readToken(home, ctx);
  if (!cfg || cfg.machineId === undefined || cfg.machineName === undefined || token === null) {
    throw new CliError(EXIT.AUTH, "尚未登录", LOGIN_HINT);
  }
  const agent = resolveAgent(agentFlag, ctx.env);
  const client = new ApiClient({ server: cfg.server, token, agent, fetch: ctx.fetch });
  return { client, machine: { id: cfg.machineId, name: cfg.machineName }, server: cfg.server };
}

/** 要求当前目录在一个已注册的仓库里，找不到时 CliError(2)，提示先执行 kh register */
export async function requireRegisteredRepo(ctx: CliContext): Promise<RegisteredRepo> {
  const repo = await findRegisteredRepo(ctx.cwd, ctx);
  if (!repo) {
    throw new CliError(EXIT.USAGE, "当前目录不在已注册的仓库里", REGISTER_HINT);
  }
  return repo;
}

/** 加载项目详情（项目本体 + 看板） */
export function loadProject(client: ApiClient, projectId: string): Promise<ProjectDetailResponse> {
  return client.get(`/api/v1/projects/${projectId}`, projectDetailResponse);
}

/** 把 core 的 RefResult 映射成 CliError：写法不合法是用法错误（2），找不到或有歧义是数据错误（5） */
function refErrorFrom(result: Extract<RefResult, { ok: false }>): CliError {
  return new CliError(result.reason === "invalid" ? EXIT.USAGE : EXIT.DATA, result.message);
}

/** 解析容器引用（编号 / misc / ID 前缀），失败时抛出对应退出码的 CliError，成功时返回容器对象 */
export function resolveContainerOrFail(board: Pick<Board, "containers">, ref: string): Container {
  const result = resolveContainerRef(board.containers, ref);
  if (!result.ok) throw refErrorFrom(result);
  const container = board.containers.find((c) => c.id === result.id);
  if (!container) throw new CliError(EXIT.UNEXPECTED, `内部错误：容器 ${result.id} 解析成功但在看板里找不到`);
  return container;
}

/** 解析任务引用（#短ID / 容器编号/任务编号 / 完整 ID），失败时抛出对应退出码的 CliError，成功时返回任务对象 */
export function resolveTaskOrFail(board: Pick<Board, "containers" | "tasks">, ref: string): Task {
  const result = resolveTaskRef(board, ref);
  if (!result.ok) throw refErrorFrom(result);
  const task = board.tasks.find((t) => t.id === result.id);
  if (!task) throw new CliError(EXIT.UNEXPECTED, `内部错误：任务 ${result.id} 解析成功但在看板里找不到`);
  return task;
}

/** 任务 ID 在整个看板范围内取最短唯一前缀（至少 4 位），格式化成 #xxxx 供命令输出使用 */
export function shortRef(board: Pick<Board, "tasks">, taskId: string): string {
  const prefixes = shortIdPrefixes(board.tasks.map((t) => t.id));
  const prefix = prefixes.get(taskId);
  if (prefix === undefined) throw new CliError(EXIT.UNEXPECTED, `内部错误：任务 ${taskId} 不在看板里`);
  return `#${prefix}`;
}

/**
 * 看板写命令成功后调用，记录最近一次上报时间供 M6 的 Stop hook 判断；
 * 写失败（包括 KH_HOME 本身解析失败）只忽略，不影响命令本身已经成功的结果。
 */
export async function afterReport(ctx: CliContext, projectId: string): Promise<void> {
  try {
    const home = resolveKhHome(ctx);
    await recordReport(home, projectId, ctx.now());
  } catch {
    // 忽略：上报时间只是辅助信息，写失败不应该让已经成功的命令报错
  }
}

/** 校验命令行传入的枚举取值；不合法时列出全部可选值及中文名 */
export function parseEnumOption<T extends string>(value: string, values: readonly T[], labels: Record<T, string>): T {
  if ((values as readonly string[]).includes(value)) return value as T;
  const options = values.map((v) => `${v}（${labels[v]}）`).join("、");
  throw new CliError(EXIT.USAGE, `不支持的取值：${value}`, `可选值：${options}`);
}

/**
 * 处理“清空可空字段”的约定：命令行选项没有传（undefined）表示不改动这个字段，
 * 传空串表示清空为 null，传其他字符串原样使用。
 */
export function parseNullableOption(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value === "" ? null : value;
}
