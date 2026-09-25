import type { Command } from "commander";
import { projectDetailResponse, type ProjectDetailResponse } from "@kanban-hub/core/api";
import { shortIdPrefixes } from "@kanban-hub/core/ids";
import { resolveContainerRef, resolveTaskRef, type RefResult } from "@kanban-hub/core/refs";
import { dateSchema, type Board, type Container, type Task } from "@kanban-hub/core/schema";
import { resolveAgent } from "../agent";
import type { CliContext } from "../context";
import { CliError, EXIT } from "../errors";
import { loginHint, readMachineConfig, readToken, resolveKhHome } from "../config/home";
import { ApiClient } from "../http/client";
import { recordReport } from "../report-log";
import { findRegisteredRepo, type RegisteredRepo } from "../repo/root";

const REGISTER_HINT = "kh register";

export interface LoggedIn {
  client: ApiClient;
  machine: { id: string; name: string };
  server: string;
}

/**
 * 给会发请求的叶子命令加一个 --agent <名称>：根命令开了 enablePositionalOptions 之后，
 * 全局 --agent 只在子命令名之前识别，写在子命令后面（例如 kh task set … --agent x）就需要
 * 子命令自己也声明这个选项才能生效。所有会调用 requireLogin 的叶子命令都要用它。
 */
export function withAgentOption(cmd: Command): Command {
  return cmd.option("--agent <名称>", "标注上报事件的 agent 名称，不指定时按运行环境自动识别");
}

/**
 * 读取 --agent 的原始值：优先取当前命令自己的值（withAgentOption 加在叶子命令上的那个），
 * 取不到再退回全局值（用 commander 15 的 optsWithGlobals() 沿父链合并）——这样 --agent
 * 写在子命令前面、后面都生效，两处都给时以子命令上的为准。
 * agent 的识别（--agent 优先，其次按环境变量对照表）统一收在 requireLogin 里，调用方只需要把
 * 这个原始值转交过去，不用（也不应该）自己再调 resolveAgent——写命令一旦漏掉这一步，或者只传了
 * --agent 没有回退到环境变量，上报的事件就会丢失 CLAUDECODE 这类自动识别。
 */
export function globalAgentFlag(cmd: Command): string | undefined {
  const local = (cmd.opts() as { agent?: unknown }).agent;
  if (typeof local === "string") return local;
  const merged = (cmd.optsWithGlobals() as { agent?: unknown }).agent;
  return typeof merged === "string" ? merged : undefined;
}

/**
 * 要求本机已经登录：没有本机配置、没有配对过（缺 machineId/machineName）、或凭据文件缺失，
 * 都当作未登录处理（CliError(3)），提示重新执行 kh login。
 * agentFlag 是 --agent 的原始值（用 globalAgentFlag(cmd) 取得），这里统一调 resolveAgent 解析
 * 成最终 agent（不合法是用法错误），再交给 ApiClient；login/whoami 也走这条路径，保证
 * 所有会发请求的命令都用同一套逻辑决定 X-KH-Agent，不会有的传了 --agent、有的漏了环境变量。
 * resolveAgent 排在最前面：--agent 不合法是纯本地就能判定的用法错误（2），不应该等到读完
 * 本机配置和凭据、发现“尚未登录”（3）之后才报——本地能查出来的问题应该最先暴露。
 */
export async function requireLogin(ctx: CliContext, agentFlag?: string): Promise<LoggedIn> {
  const agent = resolveAgent(agentFlag, ctx.env);
  const home = resolveKhHome(ctx);
  const cfg = await readMachineConfig(home);
  const token = await readToken(home, ctx);
  if (!cfg || cfg.machineId === undefined || cfg.machineName === undefined || token === null) {
    throw new CliError(EXIT.AUTH, "尚未登录", loginHint(cfg?.server));
  }
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

/**
 * 加载项目详情，项目找不到（服务端返回 5：带错误信封的 404）时补一条提示：
 * 这个 projectId 来自仓库的 .kanban-hub/config.yaml，找不到多半是这个文件的内容不对，
 * 而不是别的原因。status 和 register 的补登记分支都会遇到同样的情况，共用这一份提示。
 */
export async function loadProjectOrFail(client: ApiClient, projectId: string): Promise<ProjectDetailResponse> {
  try {
    return await loadProject(client, projectId);
  } catch (err) {
    if (err instanceof CliError && err.exitCode === EXIT.DATA) {
      throw new CliError(err.exitCode, err.message, err.hint ?? "请检查仓库配置 .kanban-hub/config.yaml 里的 projectId 是否正确");
    }
    throw err;
  }
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

/**
 * 校验命令行传入的可空日期选项：不传（undefined）表示不改动字段，传空字符串表示清空（null），
 * 其余按 core 的 dateSchema 校验格式（YYYY-MM-DD），格式不对时是用法错误。container、task 共用。
 */
export function parseNullableDateOption(raw: string | undefined): string | null | undefined {
  const value = parseNullableOption(raw);
  if (typeof value !== "string") return value;
  const result = dateSchema.safeParse(value);
  if (!result.success) {
    throw new CliError(EXIT.USAGE, `日期格式不对：${value}`, "使用 YYYY-MM-DD 格式，例如 2026-09-25");
  }
  return value;
}

/** 命令输出里统一的空值占位：null 或空字符串都显示成全角“（无）”，非空原样显示 */
export function displayEmpty(value: string | null | undefined): string {
  return value === null || value === undefined || value === "" ? "（无）" : value;
}

/**
 * 容器在命令输出里的显示标签：有编号用编号；杂项容器固定显示 misc；否则用整个看板范围内
 * 能互相区分的最短 ID 前缀（至少 4 位）——resolveContainerRef 认 ID 前缀，这样写出来的
 * "<前缀>/2.4" 能直接拿来引用容器或任务，不会像旧版的 "(无编号)" 占位那样没法用。
 */
export function containerRefLabel(
  container: Pick<Container, "id" | "kind" | "code">,
  allContainers: readonly Pick<Container, "id">[],
): string {
  if (container.code !== null) return container.code;
  if (container.kind === "misc") return "misc";
  const prefixes = shortIdPrefixes(allContainers.map((c) => c.id));
  return prefixes.get(container.id) ?? container.id;
}

/** 至少要给一个要修改的选项，否则用法错误（2），不发请求；project/container/task set 共用 */
export function assertAnyOptionGiven(given: readonly boolean[], hint?: string): void {
  if (given.some(Boolean)) return;
  throw new CliError(EXIT.USAGE, "请至少提供一个要修改的选项", hint);
}

/** 拼一行“字段变化”的输出：<标签> <改前> → <改后>；project/container/task 共用 */
export function formatChange(label: string, from: string, to: string): string {
  return `${label} ${from} → ${to}`;
}
