import type { Command } from "commander";
import { meResponse, pairInput, pairResponse } from "@kanban-hub/core/api";
import { formatZodError } from "@kanban-hub/core/errors";
import type { MachineOs } from "@kanban-hub/core/schema";
import { KH_VERSION } from "@kanban-hub/core/version";
import { resolveAgent } from "../agent";
import type { CliContext } from "../context";
import { CliError, EXIT } from "../errors";
import {
  clearMachineIdentity,
  normalizeServerOrigin,
  readMachineConfig,
  resolveKhHome,
  writeMachineConfig,
  writeToken,
} from "../config/home";
import { ApiClient } from "../http/client";
import { globalAgentFlag, requireLogin, withAgentOption } from "./shared";

const PLATFORM_TO_OS: Partial<Record<NodeJS.Platform, MachineOs>> = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows",
};

/**
 * --server 只接受 http/https 的 origin，去掉末尾的斜杠；不合法（协议不对、不是合法 URL、
 * 带用户名密码、带路径或查询参数）时抛用法错误。规则与本机配置的 server 字段共用，见
 * config/home.ts 的 normalizeServerOrigin。
 */
export function normalizeServerUrl(raw: string): string {
  return normalizeServerOrigin(raw);
}

/** 把 Node 的 platform 映射成机器 os 枚举（darwin/linux/win32 → darwin/linux/windows）；其他平台抛用法错误 */
export function mapPlatformToOs(platform: NodeJS.Platform): MachineOs {
  const os = PLATFORM_TO_OS[platform];
  if (!os) throw new CliError(EXIT.USAGE, `不支持的操作系统：${platform}`);
  return os;
}

/** --name 默认取主机名，去掉常见的 .local 后缀（macOS 的 Bonjour 名称） */
function defaultMachineName(hostname: string): string {
  return hostname.replace(/\.local$/, "");
}

interface LoginOptions {
  server?: string;
  code: string;
  name?: string;
}

async function runLogin(ctx: CliContext, opts: LoginOptions, agentFlag?: string): Promise<void> {
  const home = resolveKhHome(ctx);
  const existing = await readMachineConfig(home);

  const serverRaw = opts.server ?? existing?.server;
  if (serverRaw === undefined) {
    throw new CliError(EXIT.USAGE, "缺少服务端地址", "首次登录需要提供 --server <地址>");
  }
  const server = normalizeServerUrl(serverRaw);
  const os = mapPlatformToOs(ctx.platform);
  const machineName = opts.name ?? defaultMachineName(ctx.hostname);

  // 请求体先过 core 的输入 schema，把能在本地发现的错误（名称超长等）拦在本地
  const parsedInput = pairInput.safeParse({ code: opts.code, machineName, os });
  if (!parsedInput.success) {
    throw new CliError(EXIT.USAGE, formatZodError(parsedInput.error).join("；"));
  }

  // agent 的识别统一走 resolveAgent（--agent 优先，其次环境变量对照表），与 requireLogin 内部一致
  const agent = resolveAgent(agentFlag, ctx.env);

  const client = new ApiClient({ server, agent, fetch: ctx.fetch });
  const paired = await client.post("/api/v1/pair", parsedInput.data, pairResponse);

  await writeMachineConfig(home, { server, machineId: paired.machineId, machineName });
  await writeToken(home, paired.token);

  // 配对成功后调用 /me 确认新令牌确实可用
  const authed = new ApiClient({ server, token: paired.token, agent, fetch: ctx.fetch });
  const me = await authed.get("/api/v1/me", meResponse);

  ctx.stdout.write(`已登录到 ${server}\n`);
  ctx.stdout.write(`用户：${me.user.name}\n`);
  ctx.stdout.write(`本机：${machineName}（${paired.machineId}）\n`);

  if (existing?.machineId !== undefined && existing.machineName !== undefined) {
    ctx.stdout.write(
      `提示：本机之前的机器身份“${existing.machineName}”（${existing.machineId}）仍然保留在服务端，如需失效请到网页的设置页面吊销\n`,
    );
  }
}

async function runLogout(ctx: CliContext): Promise<void> {
  const home = resolveKhHome(ctx);
  await clearMachineIdentity(home);
  ctx.stdout.write("已登出，服务端地址已保留\n");
  ctx.stdout.write("提示：令牌在服务端仍然有效，如需失效请到网页的设置页面吊销这台机器\n");
}

async function runWhoami(ctx: CliContext, agentFlag?: string): Promise<void> {
  const { client, machine, server } = await requireLogin(ctx, agentFlag);
  const me = await client.get("/api/v1/me", meResponse);
  const machineInfo = me.machine ?? machine;

  ctx.stdout.write(`服务端：${server}\n`);
  ctx.stdout.write(`用户：${me.user.name}\n`);
  ctx.stdout.write(`本机：${machineInfo.name}（${machineInfo.id}）\n`);
  ctx.stdout.write(`服务端版本：${me.serverVersion}\n`);
  ctx.stdout.write(`kh 版本：${KH_VERSION}\n`);
}

/** kh login / logout / whoami：登录、登出、查看当前登录状态 */
export function registerAuth(program: Command, ctx: CliContext): void {
  withAgentOption(
    program
      .command("login")
      .description("登录到 kanban-hub 服务端，保存本机凭据")
      .option("--server <地址>", "服务端地址（http 或 https），省略时沿用已保存的地址")
      .requiredOption("--code <配对码>", "从服务端 /setup 页面获取的配对码")
      .option("--name <名称>", "本机名称，默认取主机名（去掉 .local 后缀）"),
  ).action(async (opts: LoginOptions, cmd: Command) => {
    await runLogin(ctx, opts, globalAgentFlag(cmd));
  });

  program
    .command("logout")
    .description("删除本机凭据（服务端地址保留在本机配置里）")
    .action(async () => {
      await runLogout(ctx);
    });

  withAgentOption(program.command("whoami").description("显示当前登录状态")).action(
    async (_opts: unknown, cmd: Command) => {
      await runWhoami(ctx, globalAgentFlag(cmd));
    },
  );
}
