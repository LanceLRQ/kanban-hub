/**
 * rehype 插件：按 `resolveDocLink` 改写 `a[href]`/`img[src]`。
 * 必须排在 rehype-sanitize 之后（改写后的站内链接不应该再被当成外部 URL 清洗）、
 * rehype-highlight 之前（改写不影响代码块，顺序只是遵循渲染管线的固定顺序）。
 */
import { visit } from "unist-util-visit";
import type { Element, Root } from "hast";
import { resolveDocLink, type DocLinkCtx } from "./doc-links";

const MISSING_CLASS = "kh-doc-link-missing";
const MISSING_TITLE = "文件不在快照中";

function isHttpLike(href: string): boolean {
  return /^https?:/i.test(href);
}

function applyResult(node: Element, attr: "href" | "src", result: ReturnType<typeof resolveDocLink>): void {
  const props = node.properties ?? (node.properties = {});
  switch (result.kind) {
    case "doc":
    case "raw":
      props[attr] = result.href;
      if (result.kind === "raw" && attr === "href") {
        props.target = "_blank";
        props.rel = ["noopener", "noreferrer"];
      }
      return;
    case "external":
      // 值不一定和原始 href 完全一样：同页锚点会按 sanitize 的 user-content- 前缀改写过
      props[attr] = result.href;
      if (attr === "href" && isHttpLike(result.href)) {
        props.target = "_blank";
        props.rel = ["noopener", "noreferrer"];
      }
      return;
    case "missing": {
      delete props[attr];
      const existing = props.className;
      const classes = Array.isArray(existing) ? [...existing] : typeof existing === "string" ? [existing] : [];
      props.className = [...classes, MISSING_CLASS];
      props.title = MISSING_TITLE;
      return;
    }
    case "drop":
      delete props[attr];
  }
}

export function rehypeDocLinks(currentPath: string, ctx: DocLinkCtx) {
  return (tree: Root): void => {
    visit(tree, "element", (node: Element) => {
      if (node.tagName === "a" && typeof node.properties?.href === "string") {
        applyResult(node, "href", resolveDocLink(node.properties.href, currentPath, ctx));
      } else if (node.tagName === "img" && typeof node.properties?.src === "string") {
        applyResult(node, "src", resolveDocLink(node.properties.src, currentPath, ctx));
      }
    });
  };
}
