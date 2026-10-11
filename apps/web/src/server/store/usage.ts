import fs from "node:fs/promises";
import path from "node:path";

/** 一类内容的占用：字节数（文件的表观大小之和）与文件数 */
export interface UsageEntry {
  bytes: number;
  files: number;
}

/** 一个项目在数据目录里的占用：看板与事件数据、文档快照与清单两栏 */
export interface ProjectUsage {
  projectId: string;
  board: UsageEntry;
  docs: UsageEntry;
}

/**
 * 数据目录的存储占用分项（设置页显示）。只统计普通文件的表观大小；软链接等特殊文件
 * 不计入（kh 推送时就跳过它们，快照目录里不会有）。git 仓库（.git/）按打包压缩前的
 * 对象文件计，与 `du` 的磁盘占用会有出入。只读，不进写入队列。
 */
export interface StorageUsage {
  /** 看板与事件数据：projects/&lt;项目ID&gt;/ 下除 snapshots/、manifests/ 外的文件 */
  board: UsageEntry;
  /** 文档快照与清单：projects/&lt;项目ID&gt;/snapshots/ 与 manifests/ */
  docs: UsageEntry;
  /** 凭据：auth/（不进 git，但占磁盘） */
  auth: UsageEntry;
  /** git 仓库：.git/ */
  git: UsageEntry;
  /** 其他：根上的 .gitignore、单实例锁、.staging/、.tmp/ 等临时内容 */
  other: UsageEntry;
  /** 各项目的小计（不含 .git 与凭据），按合计降序、同大小按项目 ID，保证结果确定 */
  projects: ProjectUsage[];
}

const EMPTY: UsageEntry = { bytes: 0, files: 0 };

/** 相对路径属于哪一类：git / auth / 项目（再分看板与文档）/ 其他 */
function classify(rel: string): { kind: "git" | "auth" | "other" } | { kind: "project"; projectId: string; docs: boolean } {
  if (rel === ".git" || rel.startsWith(".git/")) return { kind: "git" };
  if (rel.startsWith("auth/")) return { kind: "auth" };
  const project = /^projects\/([^/]+)(?:\/(snapshots|manifests)(?:\/|$)|\/|$)/.exec(rel);
  if (project) return { kind: "project", projectId: project[1]!, docs: project[2] !== undefined };
  return { kind: "other" };
}

/**
 * 遍历数据目录统计各分项占用。读不到的条目（权限、并发中被删掉）跳过不数——
 * 只是展示用的数字，不值得为一个正在变化的目录报错。
 */
export async function measureStorageUsage(dataDir: string): Promise<StorageUsage> {
  const usage: StorageUsage = {
    board: { ...EMPTY },
    docs: { ...EMPTY },
    auth: { ...EMPTY },
    git: { ...EMPTY },
    other: { ...EMPTY },
    projects: [],
  };
  const byProject = new Map<string, ProjectUsage>();
  let entries;
  try {
    entries = await fs.readdir(dataDir, { recursive: true, withFileTypes: true });
  } catch {
    return usage;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const rel = path.relative(dataDir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/");
    const stat = await fs.stat(path.join(entry.parentPath, entry.name)).catch(() => null);
    if (!stat) continue;
    const verdict = classify(rel);
    if (verdict.kind === "project") {
      let project = byProject.get(verdict.projectId);
      if (!project) {
        project = { projectId: verdict.projectId, board: { ...EMPTY }, docs: { ...EMPTY } };
        byProject.set(verdict.projectId, project);
      }
      const slot = verdict.docs ? project.docs : project.board;
      slot.bytes += stat.size;
      slot.files += 1;
      const total = verdict.docs ? usage.docs : usage.board;
      total.bytes += stat.size;
      total.files += 1;
    } else {
      const slot = usage[verdict.kind];
      slot.bytes += stat.size;
      slot.files += 1;
    }
  }
  usage.projects = [...byProject.values()].sort((a, b) => {
    const diff = a.board.bytes + a.docs.bytes - (b.board.bytes + b.docs.bytes);
    if (diff !== 0) return -diff;
    return a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0;
  });
  return usage;
}
