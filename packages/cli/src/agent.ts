import { CliError, EXIT } from "./errors";

const AGENT_NAME_MAX_LENGTH = 50;

type EnvLike = Record<string, string | undefined>;

function hasValue(v: string | undefined): boolean {
  return v !== undefined && v !== "";
}

/**
 * 按环境变量对照表识别当前运行的 agent（规格没写的细节，见里程碑 context 的“agent 识别”）。
 * 识别结果只用于标注事件的操作者，不参与任何判断；都没有时返回 null。
 * 优先级：CLAUDECODE > GEMINI_CLI > CODEX_SANDBOX/CODEX_THREAD_ID > OPENCODE。
 */
export function detectAgent(env: EnvLike): string | null {
  if (env.CLAUDECODE === "1") return "claude-code";
  if (env.GEMINI_CLI === "1") return "gemini-cli";
  if (hasValue(env.CODEX_SANDBOX) || hasValue(env.CODEX_THREAD_ID)) return "codex";
  if (env.OPENCODE === "1") return "opencode";
  return null;
}

/** --agent 优先于环境变量识别；超过 50 个字符是用法错误 */
export function resolveAgent(flag: string | undefined, env: EnvLike): string | null {
  if (flag !== undefined) {
    if (flag.length > AGENT_NAME_MAX_LENGTH) {
      throw new CliError(EXIT.USAGE, `--agent 不能超过 ${AGENT_NAME_MAX_LENGTH} 个字符（收到 ${flag.length} 个）`);
    }
    return flag;
  }
  return detectAgent(env);
}
