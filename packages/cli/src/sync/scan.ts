import type { Dirent, Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import picomatch from "picomatch";
import type { SyncScope } from "@kanban-hub/core/schema";
import { SYNC_ALWAYS_EXCLUDE } from "@kanban-hub/core/sync";
import { KH_TMP_PATTERN } from "../fs-utils";
import { REPO_CONFIG_DIR } from "../repo/config";

export interface ScanFile {
  path: string;
  absPath: string;
  size: number;
  mtimeMs: number;
}

export interface ScanResult {
  files: ScanFile[];
  skipped: { path: string; size: number }[];
  ignoredLinks: string[];
}

type Matcher = (input: string) => boolean;
interface Matchers {
  include: Matcher[];
  exclude: Matcher[];
}

function buildMatchers(scope: SyncScope): Matchers {
  // dot: true 让 docs/** 这类模式也能匹配 docs/.hidden；* 默认不跨目录分隔符，这一点
  // 由 picomatch 的默认行为保证，不需要额外配置
  const opts = { dot: true };
  return {
    include: scope.include.map((pattern) => picomatch(pattern, opts)),
    exclude: [...SYNC_ALWAYS_EXCLUDE, ...scope.exclude].map((pattern) => picomatch(pattern, opts)),
  };
}

function isMatch(relPath: string, matchers: Matchers): boolean {
  if (matchers.exclude.some((m) => m(relPath))) return false;
  return matchers.include.some((m) => m(relPath));
}

/**
 * 单个路径是否在同步范围内：命中始终排除或 exclude 的一律排除，其余再看是否命中 include。
 * 每次调用都会重新编译 glob，不适合在循环里反复调用；循环里用 createSyncScopeMatcher。
 */
export function matchesSyncScope(relPath: string, scope: SyncScope): boolean {
  return isMatch(relPath, buildMatchers(scope));
}

/** 与 matchesSyncScope 同样的判定，但 glob 只编译一次，适合逐个判断一批路径 */
export function createSyncScopeMatcher(scope: SyncScope): (relPath: string) => boolean {
  const matchers = buildMatchers(scope);
  return (relPath) => isMatch(relPath, matchers);
}

function isLiteralSegment(seg: string): boolean {
  return seg !== "**" && !/[*?{}[\]!]/.test(seg);
}

/**
 * include 模式里不含通配符的目录前缀：扫描只从这里开始遍历，不会去读遍整个仓库。
 * 最后一段永远当作文件名匹配处理（哪怕它本身也是字面量），不算作目录的一部分。
 */
function staticPrefix(pattern: string): string {
  const segs = pattern.split("/");
  const literal: string[] = [];
  for (const seg of segs) {
    if (!isLiteralSegment(seg)) break;
    literal.push(seg);
  }
  if (literal.length === segs.length) literal.pop();
  return literal.join("/");
}

/** 去掉被其他前缀覆盖的前缀（自身或祖先目录已经在列表里，再单独遍历就是重复工作） */
function dedupePrefixes(prefixes: string[]): string[] {
  const sorted = [...new Set(prefixes)].sort((a, b) => a.length - b.length);
  const kept: string[] = [];
  for (const candidate of sorted) {
    if (kept.some((k) => k === "" || candidate === k || candidate.startsWith(`${k}/`))) continue;
    kept.push(candidate);
  }
  return kept;
}

// 无论仓库配置怎么写都始终排除的目录名，从 SYNC_ALWAYS_EXCLUDE 里形如 "任意深度/名字/任意深度"
// 的写法中提取出来；扫描据此在遇到这些目录时直接剪枝，不需要进去看内容
const ALWAYS_EXCLUDE_DIR_NAMES = new Set(
  SYNC_ALWAYS_EXCLUDE.map((pattern) => /^\*\*\/([^*/]+)\/\*\*$/.exec(pattern)?.[1]).filter(
    (name): name is string => name !== undefined,
  ),
);

/** 仓库根的 .kanban-hub/ 是 kh 自己的配置目录，与 kh 的临时文件一样不参与同步（比较不区分大小写） */
function isRepoConfigPath(relPath: string): boolean {
  return relPath.split("/")[0]!.toLowerCase() === REPO_CONFIG_DIR.toLowerCase();
}

/**
 * 扫描仓库内符合同步范围的文件。只从 include 各模式的静态前缀开始遍历（例如 docs/** 只从
 * docs/ 开始），前缀之外即使有读不了的目录也不会被访问到，因此不会抛错。
 */
export async function scanSyncFiles(root: string, scope: SyncScope): Promise<ScanResult> {
  const matchers = buildMatchers(scope);
  const files = new Map<string, ScanFile>();
  const skipped = new Map<string, { path: string; size: number }>();
  const ignoredLinks = new Set<string>();

  function classify(relPath: string, absPath: string, size: number, mtimeMs: number): void {
    if (KH_TMP_PATTERN.test(path.basename(relPath)) || isRepoConfigPath(relPath)) return;
    if (!isMatch(relPath, matchers)) return;
    if (size > scope.maxFileSize) {
      skipped.set(relPath, { path: relPath, size });
      return;
    }
    files.set(relPath, { path: relPath, absPath, size, mtimeMs });
  }

  async function visitSymlink(relPath: string, absPath: string): Promise<void> {
    let real: string;
    try {
      real = await fs.realpath(absPath);
    } catch {
      ignoredLinks.add(relPath); // 目标不存在：失效的软链接
      return;
    }

    let stat: Stats;
    try {
      stat = await fs.stat(absPath); // 跟随链接，拿目标的信息
    } catch {
      ignoredLinks.add(relPath);
      return;
    }

    // 目录软链接一律不进入，防止循环和重复；这不算失效链接，不记入 ignoredLinks
    if (stat.isDirectory()) return;
    if (!stat.isFile()) {
      ignoredLinks.add(relPath);
      return;
    }

    const relToRoot = path.relative(root, real);
    const inside = relToRoot !== "" && !relToRoot.startsWith("..") && !path.isAbsolute(relToRoot);
    if (!inside) {
      ignoredLinks.add(relPath);
      return;
    }
    classify(relPath, absPath, stat.size, stat.mtimeMs);
  }

  async function visitDir(dirAbs: string, dirRel: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return; // 目录不存在或读不了：安静地跳过，调用方不需要因此中断
    }

    for (const entry of entries) {
      const rel = dirRel === "" ? entry.name : `${dirRel}/${entry.name}`;
      const abs = path.join(dirAbs, entry.name);

      if (entry.isSymbolicLink()) {
        await visitSymlink(rel, abs);
        continue;
      }
      if (entry.isDirectory()) {
        if (ALWAYS_EXCLUDE_DIR_NAMES.has(entry.name) || isRepoConfigPath(rel)) continue;
        await visitDir(abs, rel);
        continue;
      }
      if (entry.isFile()) {
        const stat = await fs.stat(abs);
        classify(rel, abs, stat.size, stat.mtimeMs);
      }
    }
  }

  const prefixes = dedupePrefixes(scope.include.map(staticPrefix));
  for (const prefix of prefixes) {
    const abs = prefix === "" ? root : path.join(root, ...prefix.split("/"));
    await visitDir(abs, prefix);
  }

  const byPath = (a: { path: string }, b: { path: string }): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return {
    files: [...files.values()].sort(byPath),
    skipped: [...skipped.values()].sort(byPath),
    ignoredLinks: [...ignoredLinks].sort(),
  };
}
