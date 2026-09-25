import fs from "node:fs/promises";
import path from "node:path";
import { isNoEntError, writeFileAtomic } from "./fs-utils";
import type { RepoInspection } from "./root";

const EXCLUDE_LINE = "/.kanban-hub/";
/** info/exclude 里已有的等价写法，出现任意一种就不重复写 */
const EQUIVALENT_LINES = new Set([".kanban-hub", ".kanban-hub/", "/.kanban-hub", "/.kanban-hub/"]);

export interface ExcludePlan {
  path: string;
  needed: boolean;
}

export interface ExcludeResult {
  path: string;
  changed: boolean;
}

async function readExcludeContent(excludePath: string): Promise<string> {
  try {
    return await fs.readFile(excludePath, "utf8");
  } catch (err) {
    if (isNoEntError(err)) return "";
    throw err;
  }
}

function hasEquivalentLine(content: string): boolean {
  return content.split("\n").some((line) => EQUIVALENT_LINES.has(line.trim()));
}

/** info/exclude 写在 git-common-dir 下：链接工作树也共用主仓库的这一份，所有工作树共享 */
function excludePathFor(repo: Pick<RepoInspection, "isGit" | "commonDir">): string | null {
  if (!repo.isGit || repo.commonDir === null) return null;
  return path.join(repo.commonDir, "info", "exclude");
}

/** 只检查 info/exclude 是否已经排除了 .kanban-hub/，不写任何文件 */
export async function planExclude(repo: RepoInspection): Promise<ExcludePlan> {
  const excludePath = excludePathFor(repo);
  if (excludePath === null) return { path: "", needed: false };

  const content = await readExcludeContent(excludePath);
  return { path: excludePath, needed: !hasEquivalentLine(content) };
}

/**
 * 追加 /.kanban-hub/ 到 info/exclude；已经有等价写法就不重复写。
 * 保留原有内容和结尾换行：只在原内容缺少换行符时补一个，再追加新的一行。
 */
export async function ensureExcluded(repo: RepoInspection): Promise<ExcludeResult> {
  const plan = await planExclude(repo);
  if (!plan.needed) return { path: plan.path, changed: false };

  const content = await readExcludeContent(plan.path);
  let next = content;
  if (next !== "" && !next.endsWith("\n")) next += "\n";
  next += `${EXCLUDE_LINE}\n`;

  await fs.mkdir(path.dirname(plan.path), { recursive: true });
  await writeFileAtomic(plan.path, next);
  return { path: plan.path, changed: true };
}
