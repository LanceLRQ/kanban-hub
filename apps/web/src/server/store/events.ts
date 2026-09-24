import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { KhError } from "@kanban-hub/core/errors";
import { idSchema } from "@kanban-hub/core/ids";
import { type Event, eventSchema } from "@kanban-hub/core/schema";
import { appendJsonLine, readJsonLines, repairJsonLinesTail } from "./fsio";

const MONTH_FILE_RE = /^(\d{4}-\d{2})\.jsonl$/;
const NEWLINE = 0x0a;

/** 事件所在的月份（UTC），例如 2026-09 */
export function monthOf(ts: string): string {
  return new Date(ts).toISOString().slice(0, 7);
}

/** 截至 now 所在月份的最近 count 个月，从早到晚 */
export function recentMonths(now: Date, count: number): string[] {
  const months: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    months.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
  }
  return months;
}

/** 按月分文件、只追加的事件日志：projects/<项目ID>/events/YYYY-MM.jsonl（规格 6.1） */
export class EventLog {
  constructor(private readonly dataDir: string) {}

  /** 事件文件相对数据目录的路径，供 git 提交登记；projectId 不合法（例如路径穿越）时拒绝 */
  relPath(projectId: string, month: string): string {
    this.checkProjectId(projectId);
    return `projects/${projectId}/events/${month}.jsonl`;
  }

  /** 按事件时间追加到对应月份的文件，返回相对路径。追加前修复文件末尾可能残留的半行 */
  async append(event: Event): Promise<string> {
    const rel = this.relPath(event.projectId, monthOf(event.ts));
    const file = this.abs(rel);
    await this.repairTailIfNeeded(file);
    await appendJsonLine(file, event);
    return rel;
  }

  /** 项目有事件的月份，从早到晚 */
  async listMonths(projectId: string): Promise<string[]> {
    this.checkProjectId(projectId);
    let names: string[];
    try {
      names = await fs.readdir(path.join(this.dataDir, "projects", projectId, "events"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    return names.flatMap((name) => MONTH_FILE_RE.exec(name)?.[1] ?? []).sort();
  }

  /** 读取某个月的事件；文件末尾有崩溃留下的残行时顺带修复（规格 6.5） */
  async readMonth(projectId: string, month: string): Promise<Event[]> {
    const file = this.abs(this.relPath(projectId, month));
    const lines = await readJsonLines(file, eventSchema);
    if (lines.tail !== "clean") await repairJsonLinesTail(file, lines);
    return lines.items;
  }

  /**
   * 追加前修复文件末尾可能残留的半行（规格 6.5）：崩溃可能在上一次追加时只写了一半。
   * 只读文件最后 1 个字节判断要不要修复，正常路径不整文件解析。
   * 修复后末行完整但校验不过时，readJsonLines 照常抛出 DataFileError，由 Store.mutate 按事件追加失败处理。
   */
  private async repairTailIfNeeded(file: string): Promise<void> {
    const lastByte = await readLastByte(file);
    if (lastByte === null || lastByte === NEWLINE) return; // 文件不存在、为空，或已经以换行结尾
    const lines = await readJsonLines(file, eventSchema);
    await repairJsonLinesTail(file, lines);
  }

  /** projectId 不合法时拒绝，防止拼进文件路径读写数据目录外的文件（路径穿越） */
  private checkProjectId(projectId: string): void {
    if (!idSchema.safeParse(projectId).success) throw new KhError("invalid", "项目 ID 不合法");
  }

  private abs(rel: string): string {
    return path.join(this.dataDir, ...rel.split("/"));
  }
}

/** 文件最后 1 个字节；文件不存在或为空返回 null */
async function readLastByte(file: string): Promise<number | null> {
  let handle: FileHandle;
  try {
    handle = await fs.open(file, "r");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return null;
    const buf = Buffer.alloc(1);
    await handle.read(buf, 0, 1, size - 1);
    return buf[0]!;
  } finally {
    await handle.close();
  }
}
