import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { isNoEntError, writeFileAtomic } from "../fs-utils";

/** 超过这个时长的标记在下一次 hook 运行时被顺手清理 */
const MARKER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const sessionMarkerSchema = z
  .object({
    sessionId: z.string(),
    projectId: z.string(),
    /** 注册的仓库根 */
    root: z.string(),
    /** cwd 所在工作树的顶层，见 hook/input.ts 的 resolveHookRepo */
    worktree: z.string(),
    startedAt: z.string(),
    head: z.string().nullable(),
    dirty: z.string().nullable(),
    reminded: z.boolean(),
  })
  .strict();

export type SessionMarker = z.infer<typeof sessionMarkerSchema>;

/**
 * session_id 在 readHookInput 里已经按 SESSION_ID_PATTERN 校验过；这里再用 path.basename
 * 确认拼出来的文件名没有跑到 cache/sessions/ 目录之外，双保险。
 */
function markerPath(home: string, sessionId: string): string {
  const fileName = `${sessionId}.json`;
  const dir = path.join(home, "cache", "sessions");
  if (path.basename(fileName) !== fileName) {
    // 双保险失败：把它当成一个不存在的会话处理，不写入、不读取任何文件
    return path.join(dir, "__invalid__.json");
  }
  return path.join(dir, fileName);
}

/** 读取会话标记；不存在或损坏（解析失败）都返回 null，不抛错 */
export async function readMarker(home: string, sessionId: string): Promise<SessionMarker | null> {
  const file = markerPath(home, sessionId);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if (isNoEntError(err)) return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = sessionMarkerSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/** 已存在就不覆盖：用 "wx" 排他创建，天然避免并发创建时互相覆盖 */
export async function createMarkerIfAbsent(home: string, marker: SessionMarker): Promise<void> {
  const validated = sessionMarkerSchema.parse(marker);
  const file = markerPath(home, validated.sessionId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(file, JSON.stringify(validated), { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    // 已经存在：不覆盖
  }
}

/** 把 reminded 改为 true；标记不存在（已被 gc 或从没创建过）时什么都不做 */
export async function markReminded(home: string, sessionId: string): Promise<void> {
  const current = await readMarker(home, sessionId);
  if (current === null) return;
  const file = markerPath(home, sessionId);
  await writeFileAtomic(file, JSON.stringify({ ...current, reminded: true }));
}

/** 清理 startedAt 超过 7 天的标记；文件损坏（解析不出 startedAt）也当作过期清理 */
export async function gcMarkers(home: string, now: Date): Promise<void> {
  const dir = path.join(home, "cache", "sessions");
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    // 目录不存在，或者读不到：没有标记要清理
    return;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const file = path.join(dir, entry);
    // 读取、解析这一步失败（文件损坏）也当作“已过期”，走到下面统一删除，
    // 不能让解析异常直接跳过删除——损坏的标记应该被清理，不是被放过
    let startedAtMs = Number.NaN;
    try {
      const raw = await fs.readFile(file, "utf8");
      const parsed = sessionMarkerSchema.safeParse(JSON.parse(raw));
      if (parsed.success) startedAtMs = new Date(parsed.data.startedAt).getTime();
    } catch {
      // 保持 startedAtMs 为 NaN，视为过期
    }

    if (!Number.isFinite(startedAtMs) || now.getTime() - startedAtMs > MARKER_MAX_AGE_MS) {
      try {
        await fs.rm(file, { force: true });
      } catch {
        // 删除失败：忽略，下次 gc 再处理，不影响本次 hook
      }
    }
  }
}
