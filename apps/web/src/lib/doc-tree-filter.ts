/** 文档树的路径搜索与展开辅助：纯函数，不碰 DOM 与存储 */
import type { DocTreeNode } from "./doc-tree";

/** 文件路径的所有祖先目录路径，由浅到深；根目录下的文件返回空数组 */
export function ancestorDirs(path: string): string[] {
  const segments = path.split("/");
  segments.pop();
  const result: string[] = [];
  let current = "";
  for (const seg of segments) {
    current = current === "" ? seg : `${current}/${seg}`;
    result.push(current);
  }
  return result;
}

/** 树里所有目录的路径（含各层嵌套） */
export function allDirPaths(nodes: readonly DocTreeNode[]): string[] {
  const result: string[] = [];
  for (const node of nodes) {
    if (node.type !== "dir") continue;
    result.push(node.path, ...allDirPaths(node.children));
  }
  return result;
}

export type PathMatcher = { ok: true; test: ((path: string) => boolean) | null } | { ok: false };

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compilePattern(query: string, regex: boolean): RegExp | null {
  try {
    return new RegExp(regex ? query : escapeRegExp(query), "i");
  } catch {
    return null;
  }
}

/** 按完整路径、不分大小写匹配；空查询返回 test: null（不筛选）；正则无效返回 ok: false */
export function compileMatcher(query: string, regex: boolean): PathMatcher {
  if (query === "") return { ok: true, test: null };
  const pattern = compilePattern(query, regex);
  if (!pattern) return { ok: false };
  return { ok: true, test: (path) => pattern.test(path) };
}

/** 只保留路径命中的文件及其祖先目录；count 是命中的文件数 */
export function filterTree(nodes: readonly DocTreeNode[], test: (path: string) => boolean): { nodes: DocTreeNode[]; count: number } {
  const kept: DocTreeNode[] = [];
  let count = 0;
  for (const node of nodes) {
    if (node.type === "file") {
      if (test(node.path)) {
        kept.push(node);
        count += 1;
      }
      continue;
    }
    const inner = filterTree(node.children, test);
    if (inner.count > 0) {
      kept.push({ ...node, children: inner.nodes });
      count += inner.count;
    }
  }
  return { nodes: kept, count };
}

/** 文件名里第一处命中的 [起, 止) 位置；未命中、空匹配、查询为空或正则无效时返回 null */
export function highlightRange(name: string, query: string, regex: boolean): [number, number] | null {
  if (query === "") return null;
  const pattern = compilePattern(query, regex);
  const match = pattern?.exec(name);
  if (!match || match[0] === "") return null;
  return [match.index, match.index + match[0].length];
}
