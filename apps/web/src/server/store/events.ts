import fs from "node:fs/promises";
import path from "node:path";
import { type Event, eventSchema } from "@kanban-hub/core/schema";
import { appendJsonLine, readJsonLines, repairJsonLinesTail } from "./fsio";

const MONTH_FILE_RE = /^(\d{4}-\d{2})\.jsonl$/;

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

  /** 事件文件相对数据目录的路径，供 git 提交登记 */
  relPath(projectId: string, month: string): string {
    return `projects/${projectId}/events/${month}.jsonl`;
  }

  /** 按事件时间追加到对应月份的文件，返回相对路径 */
  async append(event: Event): Promise<string> {
    const rel = this.relPath(event.projectId, monthOf(event.ts));
    await appendJsonLine(this.abs(rel), event);
    return rel;
  }

  /** 项目有事件的月份，从早到晚 */
  async listMonths(projectId: string): Promise<string[]> {
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

  private abs(rel: string): string {
    return path.join(this.dataDir, ...rel.split("/"));
  }
}
