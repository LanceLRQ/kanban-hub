/**
 * 项目位置的显示（细节「主位置」「项目页头部」）：主位置摘要
 * “机器名:路径 · 分支 · ↑a ↓b · dirty n · 同步于 X”，缺失的字段为 null，由组件决定是否显示。
 */
import type { Location, Project } from "@kanban-hub/core/schema";
import { formatRelative } from "./time";

/**
 * 项目的主位置：lastSyncAt 最近的那个；都没同步过时，取最后登记的位置（数组末尾——
 * setLocation 对同一台机器原地更新，新机器追加在末尾）。没有任何位置时为 null。
 */
export function primaryLocation(project: Pick<Project, "locations">): Location | null {
  if (project.locations.length === 0) return null;
  let best: Location | null = null;
  for (const loc of project.locations) {
    if (loc.lastSyncAt === null) continue;
    if (best === null || best.lastSyncAt === null || Date.parse(loc.lastSyncAt) > Date.parse(best.lastSyncAt)) best = loc;
  }
  return best ?? project.locations.at(-1) ?? null;
}

export interface LocationSummary {
  machineName: string;
  path: string;
  branch: string | null;
  ahead: number | null;
  behind: number | null;
  dirtyCount: number | null;
  /** 相对时间描述，从未同步过时为 null */
  syncedAt: string | null;
}

export function locationSummary(location: Location, machineName: string, now: Date): LocationSummary {
  const git = location.git;
  return {
    machineName,
    path: location.path,
    branch: git?.branch ?? null,
    ahead: git?.ahead ?? null,
    behind: git?.behind ?? null,
    dirtyCount: git?.dirtyCount ?? null,
    syncedAt: location.lastSyncAt === null ? null : formatRelative(location.lastSyncAt, now),
  };
}

/**
 * 主位置摘要行的拼接：“机器名:路径 · 分支 · ↑a ↓b · dirty n · 同步于 X”，
 * 缺失的字段跳过。`formatSyncedAt` 由调用方传入，负责套上本地化的“同步于 {value}”文案。
 */
export function formatLocationLine(location: LocationSummary, formatSyncedAt: (value: string) => string): string {
  const parts = [`${location.machineName}:${location.path}`];
  if (location.branch !== null) parts.push(location.branch);
  if (location.ahead !== null && location.behind !== null) parts.push(`↑${location.ahead} ↓${location.behind}`);
  if (location.dirtyCount !== null) parts.push(`dirty ${location.dirtyCount}`);
  if (location.syncedAt !== null) parts.push(formatSyncedAt(location.syncedAt));
  return parts.join(" · ");
}
