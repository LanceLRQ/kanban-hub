import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BackupList, backupTimeLabel } from "./backup-list";

const now = new Date("2026-09-29T04:30:00.000Z");
const TZ = "UTC";
const labels = { listLabel: "已有备份", emptyLabel: "还没有备份文件", downloadLabel: "下载" };

describe("backupTimeLabel", () => {
  it("今年的写成“9 月 20 日 03:00”，跨年的带年份", () => {
    expect(backupTimeLabel("2026-09-20T03:00:00.000Z", TZ, now)).toBe("9 月 20 日 03:00");
    expect(backupTimeLabel("2025-01-02T23:05:00.000Z", TZ, now)).toBe("2025 年 1 月 2 日 23:05");
  });
});

describe("BackupList", () => {
  it("还没有备份时给一行空状态提示", () => {
    const html = renderToStaticMarkup(<BackupList backups={[]} now={now} timeZone={TZ} {...labels} />);
    expect(html).toContain("已有备份");
    expect(html).toContain("还没有备份文件");
  });

  it("每份备份一行：时间在左栏，右侧是文件名、大小和下载链接", () => {
    const backups = [
      { fileName: "kanban-hub-20260927-030000.zip", size: 1500, createdAt: "2026-09-27T03:00:00.000Z" },
      { fileName: "kanban-hub-20260920-030000.zip", size: 4_200_000, createdAt: "2026-09-20T03:00:00.000Z" },
    ];
    const html = renderToStaticMarkup(<BackupList backups={backups} now={now} timeZone={TZ} {...labels} />);

    expect(html).toContain("9 月 27 日 03:00");
    expect(html).toContain("kanban-hub-20260927-030000.zip");
    expect(html).toContain("1.5 KB");
    expect(html).toContain("4.2 MB");
    expect(html).toContain('href="/api/v1/backups/kanban-hub-20260927-030000.zip"');
    expect(html).toContain("下载");
    // 空状态提示不再出现
    expect(html).not.toContain("还没有备份文件");
  });
});
