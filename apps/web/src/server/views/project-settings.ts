import type { Services } from "@/server/services";
import { formatDate, formatRelative, serverTimeZone } from "@/lib/time";

/** SyncScope 的展示用形状：store 给出的是深只读快照，这里就地声明成只读数组，不强转可写类型 */
export interface ProjectSettingsSyncScope {
  include: readonly string[];
  exclude: readonly string[];
  maxFileSize: number;
}

export interface ProjectSettingsLocationView {
  machineId: string;
  machineName: string;
  path: string;
  /** 没有登记同步范围（还没同步过，或 kh 版本较旧）时为 null */
  sync: ProjectSettingsSyncScope | null;
  /** 从未同步过时为 null，组件据此显示“尚未同步” */
  syncedAt: string | null;
  /** 以下四项在没有 git 信息时全部为 null（M5 之前，或者仓库根目录不是 git 仓库） */
  branch: string | null;
  ahead: number | null;
  behind: number | null;
  dirtyCount: number | null;
  headAt: string | null;
  skippedFiles: { path: string; size: number }[];
}

export interface ProjectSettingsView {
  locations: ProjectSettingsLocationView[];
}

/** 项目不存在时返回 null，调用方（页面）据此调用 `notFound()` */
export function buildProjectSettingsView(services: Services, projectId: string, now: Date): ProjectSettingsView | null {
  const project = services.store.getProject(projectId);
  if (!project) return null;

  const tz = serverTimeZone();

  const locations = project.locations.map((location) => {
    const git = location.git;
    return {
      machineId: location.machineId,
      machineName: services.store.auth.getMachine(location.machineId)?.name ?? location.machineId,
      path: location.path,
      sync: location.sync,
      syncedAt: location.lastSyncAt === null ? null : formatRelative(location.lastSyncAt, now),
      branch: git?.branch ?? null,
      ahead: git?.ahead ?? null,
      behind: git?.behind ?? null,
      dirtyCount: git?.dirtyCount ?? null,
      headAt: git?.headAt == null ? null : formatDate(git.headAt, tz, now),
      skippedFiles: location.skippedFiles.map((f) => ({ path: f.path, size: f.size })),
    };
  });

  return { locations };
}
