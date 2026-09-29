import { formatBytes } from "@/components/project-settings/format-bytes";
import { formatDate, formatTime } from "@/lib/time";
import type { BackupFileInfo } from "@/server/store/backup";
import { SectionRow } from "./section-card";

/** 列表行左侧的时间标签：“9 月 20 日 03:00”；跨年的备份带年份 */
export function backupTimeLabel(createdAt: string, timeZone: string, now: Date): string {
  return `${formatDate(createdAt, timeZone, now)} ${formatTime(createdAt, timeZone)}`;
}

/**
 * 备份列表：还没有备份时给一行提示，否则每份备份一行——时间在左栏，右侧是文件名、
 * 大小和下载链接。纯展示组件，不直接读文案与时间（由调用方传入），静态渲染即可测试。
 */
export function BackupList({
  backups,
  now,
  timeZone,
  listLabel,
  emptyLabel,
  downloadLabel,
}: {
  backups: BackupFileInfo[];
  now: Date;
  timeZone: string;
  listLabel: string;
  emptyLabel: string;
  downloadLabel: string;
}) {
  if (backups.length === 0) {
    return <SectionRow label={listLabel}>{emptyLabel}</SectionRow>;
  }
  return (
    <>
      {backups.map((backup) => (
        <SectionRow
          key={backup.fileName}
          label={<span className="kh-num">{backupTimeLabel(backup.createdAt, timeZone, now)}</span>}
        >
          <div className="flex flex-wrap items-center gap-3">
            <span className="kh-num min-w-0 break-all">{backup.fileName}</span>
            <span className="kh-num">{formatBytes(backup.size)}</span>
            {/* 接口带 Content-Disposition: attachment，浏览器点击即下载 */}
            <a href={`/api/v1/backups/${backup.fileName}`} className="underline underline-offset-2">
              {downloadLabel}
            </a>
          </div>
        </SectionRow>
      ))}
    </>
  );
}
