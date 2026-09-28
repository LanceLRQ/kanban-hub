/**
 * Markdown 里一个链接（`a[href]` 或 `img[src]`）该怎么改写：
 * - 相对路径 / 以 `/` 开头的路径，目标是清单里的 Markdown → 站内文档页链接；
 * - 目标是清单里的其他文件 → `/raw` 链接；
 * - 目标不在清单里 → `missing`，调用方保留原文字、不生成链接；
 * - http/https/mailto → `external`，原样保留；
 * - 其余协议（如 javascript:）→ `drop`，调用方去掉这个链接。
 * 只做路径判断和分类，不关心 HTML/DOM——渲染管线里的 rehype 插件负责按这个结果改 hast 节点。
 */

export interface DocLinkCtx {
  /** 目标路径（仓库相对，无协议、无锚点）是否在当前机器的快照清单里 */
  exists(path: string): boolean;
  /** 目标是 Markdown 时，生成站内文档页链接；hash 为 null 表示没有锚点 */
  docHref(path: string, hash: string | null): string;
  /** 目标是其他清单内文件时，生成 /raw 链接 */
  rawHref(path: string): string;
}

export type DocLinkResult =
  | { kind: "doc"; href: string }
  | { kind: "raw"; href: string }
  | { kind: "external"; href: string }
  | { kind: "missing" }
  | { kind: "drop" };

const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const PROTOCOL_RE = /^([a-zA-Z][a-zA-Z\d+\-.]*):/;

function isMarkdownPath(p: string): boolean {
  const ext = p.slice(p.lastIndexOf(".") + 1).toLowerCase();
  return ext === "md" || ext === "markdown";
}

/** 解析 `..`/`.`/空段，向上超出根目录时返回 null（视为无法命中任何清单内路径） */
function normalize(raw: string): string | null {
  const stack: string[] = [];
  for (const seg of raw.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (stack.length === 0) return null;
      stack.pop();
      continue;
    }
    stack.push(seg);
  }
  return stack.join("/");
}

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

function decodeSafely(p: string): string {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

/** currentPath 是当前文档页显示的文件路径（仓库相对），用于解析相对链接 */
export function resolveDocLink(href: string, currentPath: string, ctx: DocLinkCtx): DocLinkResult {
  const trimmed = href.trim();
  if (trimmed === "") return { kind: "drop" };

  const protocolMatch = PROTOCOL_RE.exec(trimmed);
  if (protocolMatch) {
    const protocol = `${protocolMatch[1]!.toLowerCase()}:`;
    return EXTERNAL_PROTOCOLS.has(protocol) ? { kind: "external", href: trimmed } : { kind: "drop" };
  }

  const hashIndex = trimmed.indexOf("#");
  const rawPathPart = hashIndex >= 0 ? trimmed.slice(0, hashIndex) : trimmed;
  const hash = hashIndex >= 0 ? trimmed.slice(hashIndex + 1) : null;

  // 纯锚点（页内跳转）：原样保留，不当作文件链接处理
  if (rawPathPart === "") return { kind: "external", href: trimmed };

  const decoded = decodeSafely(rawPathPart);
  const base = decoded.startsWith("/") ? decoded.slice(1) : `${dirname(currentPath)}/${decoded}`;
  const resolved = normalize(base);
  if (resolved === null || resolved === "" || !ctx.exists(resolved)) return { kind: "missing" };

  return isMarkdownPath(resolved) ? { kind: "doc", href: ctx.docHref(resolved, hash) } : { kind: "raw", href: ctx.rawHref(resolved) };
}
