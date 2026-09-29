import { KH_VERSION } from "@kanban-hub/core/version";
import type { Services } from "@/server/services";
import type { BackupFileInfo } from "@/server/store/backup";

export interface SettingsView {
  version: string;
  dataDirectory: string;
  /** 还没提交进 git 的改动数；0 表示没有待提交的改动。显示文案由组件决定 */
  pendingCommits: number;
  /** 没有配置 KH_PUBLIC_URL 时为 null；显示文案（“未设置（按请求地址推断）”）由组件决定 */
  publicUrl: string | null;
  staleDays: number;
  /** 备份目录里的备份，按创建时间倒序；时间与大小怎么显示由组件决定 */
  backups: BackupFileInfo[];
}

/** 设置页各区块要用到的数据，原样透传服务容器里的值，不做任何格式化 */
export function buildSettingsView(services: Services): SettingsView {
  return {
    version: KH_VERSION,
    dataDirectory: services.store.dataDirectory,
    pendingCommits: services.store.pendingCommitCount(),
    publicUrl: services.publicUrl,
    staleDays: services.staleDays,
    backups: services.store.listBackups(),
  };
}
