import { agentNameSchema } from "@kanban-hub/core/api";
import { CliError, EXIT } from "./errors";

type EnvLike = Record<string, string | undefined>;

function hasValue(v: string | undefined): boolean {
  return v !== undefined && v !== "";
}

/**
 * 按环境变量对照表识别当前运行的 agent：识别结果只用于标注事件的操作者，不参与任何判断；
 * 都没有时返回 null。优先级：CLAUDECODE > GEMINI_CLI > CODEX_SANDBOX/CODEX_THREAD_ID > OPENCODE。
 * 对照表里的值都是固定的合法字符串，不需要再过 agentNameSchema。
 */
export function detectAgent(env: EnvLike): string | null {
  if (env.CLAUDECODE === "1") return "claude-code";
  if (env.GEMINI_CLI === "1") return "gemini-cli";
  if (hasValue(env.CODEX_SANDBOX) || hasValue(env.CODEX_THREAD_ID)) return "codex";
  if (env.OPENCODE === "1") return "opencode";
  return null;
}

/**
 * --agent 优先于环境变量识别；给了但不合法（空串、含空格、非 ASCII 字符、控制字符、超过
 * 50 个字符）是用法错误，规则与服务端的 X-KH-Agent 校验共用（core 的 agentNameSchema）。
 */
export function resolveAgent(flag: string | undefined, env: EnvLike): string | null {
  if (flag !== undefined) {
    const parsed = agentNameSchema.safeParse(flag);
    if (!parsed.success) {
      throw new CliError(EXIT.USAGE, `--agent 不合法：${flag}`, "必须是 1-50 个可打印 ASCII 字符，不能包含空格");
    }
    return parsed.data;
  }
  return detectAgent(env);
}
