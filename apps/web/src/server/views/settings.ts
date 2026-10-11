import { KH_VERSION } from "@kanban-hub/core/version";
import type { Services } from "@/server/services";
import type { BackupFileInfo } from "@/server/store/backup";
import type { UsageEntry } from "@/server/store/usage";

/** 一类内容的占用；显示方式（大小、文件数）由组件决定 */
export type StorageCategoryView = UsageEntry;

/** 一个项目的占用：看板与事件数据、文档快照与清单 */
export interface StorageProjectView {
  projectId: string;
  /** 磁盘上有目录、但内存里没有这个项目（正常不会发生）时回退用项目 ID */
  name: string;
  board: StorageCategoryView;
  docs: StorageCategoryView;
}

/** 数据目录的存储占用：分项小计、总计与各项目明细 */
export interface StorageView {
  board: StorageCategoryView;
  docs: StorageCategoryView;
  auth: StorageCategoryView;
  git: StorageCategoryView;
  other: StorageCategoryView;
  totalBytes: number;
  projects: StorageProjectView[];
}

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
  /** 数据目录的存储占用（要读磁盘，所以整个构建函数是异步的） */
  storage: StorageView;
}

/** 设置页各区块要用到的数据，原样透传服务容器里的值，不做任何格式化 */
export async function buildSettingsView(services: Services): Promise<SettingsView> {
  const usage = await services.store.storageUsage();
  const names = new Map(services.store.listProjects().map((p) => [p.id, p.name]));
  const totalBytes = usage.board.bytes + usage.docs.bytes + usage.auth.bytes + usage.git.bytes + usage.other.bytes;
  return {
    version: KH_VERSION,
    dataDirectory: services.store.dataDirectory,
    pendingCommits: services.store.pendingCommitCount(),
    publicUrl: services.publicUrl,
    staleDays: services.staleDays,
    backups: services.store.listBackups(),
    storage: {
      board: usage.board,
      docs: usage.docs,
      auth: usage.auth,
      git: usage.git,
      other: usage.other,
      totalBytes,
      projects: usage.projects.map((p) => ({ ...p, name: names.get(p.projectId) ?? p.projectId })),
    },
  };
}
