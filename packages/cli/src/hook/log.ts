import fs from "node:fs/promises";
import path from "node:path";
import type { CliContext } from "../context";
import { resolveKhHome } from "../config/home";
import { isNoEntError } from "../fs-utils";

/** 单个旧文件超过这个大小时轮转，只保留一份旧文件（hook.log.1） */
const MAX_LOG_SIZE = 1024 * 1024;

export interface HookLog {
  path: string;
  /** 追加一行日志；projectId 有的话一并记下。写失败一律忽略，永不抛错 */
  write(event: string, message: string, projectId?: string): Promise<void>;
}

/** hook 专用的日志：KH_HOME/logs/hook.log，任何失败都不影响调用方 */
export function openHookLog(ctx: CliContext): HookLog {
  const home = resolveKhHome(ctx);
  const filePath = path.join(home, "logs", "hook.log");

  return {
    path: filePath,
    write: (event, message, projectId) => appendSafely(filePath, ctx, event, message, projectId),
  };
}

async function appendSafely(filePath: string, ctx: CliContext, event: string, message: string, projectId?: string): Promise<void> {
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await rotateIfNeeded(filePath);
    const parts = [ctx.now().toISOString(), event];
    if (projectId !== undefined) parts.push(projectId);
    parts.push(message);
    await fs.appendFile(filePath, `${parts.join(" ")}\n`, "utf8");
  } catch {
    // 忽略：hook.log 写失败不应该影响 hook 本身
  }
}

/** 写之前文件超过 1 MiB 时改名为 hook.log.1（覆盖旧的），只保留这一份旧文件 */
async function rotateIfNeeded(filePath: string): Promise<void> {
  let size: number;
  try {
    size = (await fs.stat(filePath)).size;
  } catch (err) {
    if (isNoEntError(err)) return;
    throw err;
  }
  if (size > MAX_LOG_SIZE) {
    await fs.rename(filePath, `${filePath}.1`);
  }
}
