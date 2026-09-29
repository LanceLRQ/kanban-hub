import fs from "node:fs/promises";
import { z } from "zod";
import type { CliContext } from "../context";
import { findRegisteredRepo, inspectRepo, type RegisteredRepo } from "../repo/root";

/** hook 从 stdin 收到的输入，只保留用得到的字段（其余原样忽略） */
export interface HookInput {
  sessionId: string;
  cwd: string;
  source: string | null;
  stopHookActive: boolean;
}

export interface ReadHookInputOptions {
  /** 读 stdin 最多等待这么久，超时视为无效输入 */
  timeoutMs?: number;
  /** 读 stdin 最多接受这么多字节，超过视为无效输入 */
  maxBytes?: number;
}

/** session_id 会拼进标记文件名，只接受这个字符集，含 "../" 之类的都被拒绝 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

const hookInputSchema = z.object({
  session_id: z.string().regex(SESSION_ID_PATTERN),
  cwd: z.string().min(1),
  source: z.string().nullable().optional(),
  stop_hook_active: z.boolean().optional(),
});

/**
 * 读取并校验 hook 的 stdin 输入：不是 JSON、字段类型不对、session_id 不合法、读取超时
 * 或超长，都返回 null（无效输入，不抛错——hook 绝不能因为这一步失败而阻塞会话）。
 */
export async function readHookInput(ctx: CliContext, opts: ReadHookInputOptions = {}): Promise<HookInput | null> {
  const raw = await readStdinRaw(ctx.stdin, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, opts.maxBytes ?? DEFAULT_MAX_BYTES);
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const result = hookInputSchema.safeParse(parsed);
  if (!result.success) return null;

  return {
    sessionId: result.data.session_id,
    cwd: result.data.cwd,
    source: result.data.source ?? null,
    stopHookActive: result.data.stop_hook_active ?? false,
  };
}

/** 有 destroy 方法就调用它；stdin 在测试里可能是简化的 stream mock，不一定有 */
function destroySafely(stream: NodeJS.ReadableStream): void {
  const destroyable = stream as unknown as { destroy?: () => void };
  if (typeof destroyable.destroy === "function") destroyable.destroy();
}

/**
 * 读到 EOF 或达到上限为止；超过等待时间或超过大小上限就放弃并返回 null，同时主动
 * destroy 这个流——不这样做的话，调用方即便已经拿到结果，进程也可能因为这个流
 * 还开着而退不出去。
 */
function readStdinRaw(stream: NodeJS.ReadableStream, timeoutMs: number, maxBytes: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finish = (result: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onError);
      resolve(result);
    };

    const abort = (): void => {
      finish(null);
      destroySafely(stream);
    };

    const onData = (chunk: Buffer | string): void => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      total += buf.length;
      if (total > maxBytes) {
        abort();
        return;
      }
      chunks.push(buf);
    };
    const onEnd = (): void => finish(Buffer.concat(chunks).toString("utf8"));
    const onError = (): void => finish(null);

    const timer = setTimeout(abort, timeoutMs);

    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
  });
}

export interface HookRepo {
  repo: RegisteredRepo;
  /** cwd 所在工作树的顶层；不是 git 仓库时等于 repo.root */
  worktree: string;
}

/**
 * 确认 cwd 存在、是目录，realpath 之后按已注册仓库的规则查找。找不到仓库，
 * 或者仓库根没有 .kanban-hub/：不是失败，是“没接入”，返回 null。
 */
export async function resolveHookRepo(ctx: CliContext, input: HookInput): Promise<HookRepo | null> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(input.cwd);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return null;

  const realCwd = await fs.realpath(input.cwd);
  const repo = await findRegisteredRepo(realCwd, ctx);
  if (repo === null) return null;

  const inspection = await inspectRepo(realCwd, ctx.env);
  const worktree = inspection.isGit ? inspection.root : repo.root;
  return { repo, worktree };
}
