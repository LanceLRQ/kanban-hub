import fs from "node:fs/promises";
import path from "node:path";
import ignore from "ignore";
import picomatch from "picomatch";
import type { SyncScope } from "@kanban-hub/core/schema";
import { SYNC_BUILTIN_IGNORE, SYNC_HARD_EXCLUDE_DIR_NAMES } from "@kanban-hub/core/sync";
import { CliError, EXIT } from "../errors";
import { isNoEntError } from "../fs-utils";
import { REPO_CONFIG_DIR, REPO_IGNORE_FILE } from "../repo/config";

/** 路径不同步的原因类别 */
export type ExcludeCategory = "hard" | "outOfInclude" | "builtin" | "ignoreFile" | "marker" | "exclude";

/** 被剪枝的目录的原因类别（硬排除的 .git 与 .kanban-hub/ 不记明细） */
export type SkippedDirCategory = "builtin" | "marker" | "ignoreFile";

/** 推送扫描时被整个跳过的目录；reason 对规则命中是规则文本，对标记是中文说明 */
export interface SkippedDir {
  path: string;
  category: SkippedDirCategory;
  reason: string;
}

export type PathVerdict = { synced: true } | { synced: false; category: ExcludeCategory; rule?: string };

export interface DirVerdict {
  /** 目录被规则表排除（或硬排除）时给出原因；否则为 null */
  excluded: { category: "hard" | "builtin" | "ignoreFile"; rule?: string } | null;
  /** 目录自身被 ! 明确加回；标记识别据此放行（祖先目录的 ! 不算） */
  selfReinstated: boolean;
}

export interface SyncRules {
  /** 路径（仓库内相对路径，POSIX 写法）是否同步，只按路径判定，不做标记识别 */
  isSynced(relPath: string): boolean;
  /** 同 isSynced，但在不同步时说明属于哪一类原因 */
  explain(relPath: string): PathVerdict;
  /** 目录是否被规则表排除、是否被加回，用于扫描剪枝与标记识别 */
  dirDecision(relDir: string): DirVerdict;
}

const MARK_BUILTIN = "builtin";
const MARK_IGNORE_FILE = "ignoreFile";

const HARD_DIR_NAMES = new Set<string>(SYNC_HARD_EXCLUDE_DIR_NAMES.map((name) => name.toLowerCase()));

/** 路径任意一段命中硬排除的目录名（不分大小写） */
function hasHardSegment(relPath: string): boolean {
  return relPath.split("/").some((seg) => HARD_DIR_NAMES.has(seg.toLowerCase()));
}

/** 读取仓库根下 .kanban-hub/ignore 的各行文本；文件不存在返回空数组，其他读取错误包成带路径的用法错误 */
export async function readIgnoreLines(root: string): Promise<string[]> {
  const filePath = path.join(root, REPO_CONFIG_DIR, REPO_IGNORE_FILE);
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (isNoEntError(err)) return [];
    const reason = err instanceof Error ? err.message : String(err);
    throw new CliError(EXIT.USAGE, `无法读取忽略文件：${filePath}（${reason}）`);
  }
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * 由同步范围与忽略文件的行构造规则对象，判定顺序见规格：硬排除、include、
 * 忽略规则表（内置规则在前、忽略文件在后）、sync.exclude。
 * ! 加回的结果会跳过 sync.exclude；父目录被加回时，其下未再命中规则的路径继承这个结果。
 */
export function createSyncRules(scope: SyncScope, ignoreLines: readonly string[]): SyncRules {
  // dot: true 让 docs/** 这类模式也能匹配 docs/.hidden；* 默认不跨目录分隔符
  const opts = { dot: true };
  const include = scope.include.map((pattern) => picomatch(pattern, opts));
  const exclude = scope.exclude.map((pattern) => picomatch(pattern, opts));

  // 匹配不分大小写是有意的：macOS 默认文件系统不分大小写，写成 Drafts/ 的人也想排除 drafts/；出错的方向是多排除
  const table = ignore({ ignorecase: true });
  for (const pattern of SYNC_BUILTIN_IGNORE) table.add({ pattern, mark: MARK_BUILTIN });
  for (const pattern of ignoreLines) table.add({ pattern, mark: MARK_IGNORE_FILE });

  const cache = new Map<string, ReturnType<typeof table.test>>();
  function test(key: string): ReturnType<typeof table.test> {
    let result = cache.get(key);
    if (result === undefined) {
      result = table.test(key);
      cache.set(key, result);
    }
    return result;
  }

  function categoryOf(rule: { mark?: string } | undefined): "builtin" | "ignoreFile" {
    return rule?.mark === MARK_IGNORE_FILE ? "ignoreFile" : "builtin";
  }

  /** 逐级检查父目录（带结尾 /）和路径自身；isDir 为 false 时最后一级按文件处理 */
  function walkTable(
    relPath: string,
    isDir: boolean,
  ): { excluded: DirVerdict["excluded"]; reinstated: boolean; selfReinstated: boolean } {
    const segs = relPath.split("/");
    let reinstated = false;
    let selfReinstated = false;
    for (let i = 1; i <= segs.length; i++) {
      const key = segs.slice(0, i).join("/") + (i < segs.length || isDir ? "/" : "");
      const result = test(key);
      if (result.ignored) {
        const rule = result.rule?.pattern;
        return {
          excluded: { category: categoryOf(result.rule), ...(rule !== undefined ? { rule } : {}) },
          reinstated,
          selfReinstated: false,
        };
      }
      if (result.unignored) {
        reinstated = true;
        if (i === segs.length) selfReinstated = true;
      }
    }
    return { excluded: null, reinstated, selfReinstated };
  }

  function explain(relPath: string): PathVerdict {
    if (hasHardSegment(relPath)) return { synced: false, category: "hard" };
    if (!include.some((m) => m(relPath))) return { synced: false, category: "outOfInclude" };
    const verdict = walkTable(relPath, false);
    if (verdict.excluded !== null) {
      return {
        synced: false,
        category: verdict.excluded.category,
        ...(verdict.excluded.rule !== undefined ? { rule: verdict.excluded.rule } : {}),
      };
    }
    if (!verdict.reinstated && exclude.some((m) => m(relPath))) return { synced: false, category: "exclude" };
    return { synced: true };
  }

  return {
    isSynced: (relPath) => explain(relPath).synced,
    explain,
    dirDecision(relDir) {
      if (hasHardSegment(relDir)) return { excluded: { category: "hard" }, selfReinstated: false };
      const { excluded, selfReinstated } = walkTable(relDir, true);
      return { excluded, selfReinstated };
    },
  };
}
