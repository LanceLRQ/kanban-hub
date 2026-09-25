import fs from "node:fs/promises";
import path from "node:path";

interface ReportRecord {
  lastReportAt: string;
}

let tmpSeq = 0;

/** 先写临时文件再重命名，保证不会留下写到一半的文件（与存储层的原子写约定一致） */
async function writeFileAtomic(file: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${++tmpSeq}`;
  try {
    await fs.writeFile(tmp, data, "utf8");
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

function isNoEntError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === "ENOENT";
}

function reportFilePath(home: string, projectId: string): string {
  return path.join(home, "cache", "reports", `${projectId}.json`);
}

/**
 * 记录某个项目最近一次成功上报的时间，供 M6 的 Stop hook 判断是否需要提醒。
 * 只有看板写命令（project set、container add/set、task *、log）成功后才调用；
 * 调用方应当忽略这里抛出的异常，写失败不影响命令本身的结果。
 */
export async function recordReport(home: string, projectId: string, now: Date): Promise<void> {
  const record: ReportRecord = { lastReportAt: now.toISOString() };
  await writeFileAtomic(reportFilePath(home, projectId), JSON.stringify(record));
}

/** 读取某个项目最近一次上报的时间；没有记录过，或记录损坏，都返回 null */
export async function readLastReport(home: string, projectId: string): Promise<Date | null> {
  let raw: string;
  try {
    raw = await fs.readFile(reportFilePath(home, projectId), "utf8");
  } catch (err) {
    if (isNoEntError(err)) return null;
    throw err;
  }

  try {
    const data = JSON.parse(raw) as Partial<ReportRecord>;
    if (typeof data.lastReportAt !== "string") return null;
    const parsed = new Date(data.lastReportAt);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  } catch {
    return null;
  }
}
