/**
 * Markdown 正文：服务端组件直接渲染成 React 元素树，不经过任何字符串拼接或 innerHTML。
 * 渲染管线固定顺序：remark-gfm → 允许原始 HTML → rehype-raw → rehype-slug（给标题生成 id）
 * → rehype-sanitize → 链接改写（见 `lib/markdown-rehype-links.ts`）→ rehype-highlight。
 *
 * rehype-slug 用 github-slugger 给标题生成 id（中文按 GitHub 的规则保留原字），必须放在
 * sanitize 之前：sanitize 的默认 schema 会给所有 id 加 `user-content-` 前缀防止 DOM
 * clobbering，链接改写（`lib/doc-links.ts` 的 `resolveDocLink`）按同一个前缀规则改写锚点，
 * 两边才能对上同一个 id。
 *
 * mermaid 代码块不在这里渲染：拦截到 `language-mermaid` 的代码块时，交给 `MermaidBlock`
 * 这个客户端组件——它按需动态加载 mermaid，页面里唯一的 innerHTML 例外就在那一个组件里
 * （渲染出的 SVG 已经过 mermaid 自带的 DOMPurify 清理）。
 */
import Markdown, { type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSlug from "rehype-slug";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeHighlight from "rehype-highlight";
import { toString as hastToString } from "hast-util-to-string";
import type { Element } from "hast";
import type { ComponentProps } from "react";
import type { DocLinkCtx } from "@/lib/doc-links";
import { rehypeDocLinks } from "@/lib/markdown-rehype-links";
import { MermaidBlock } from "./mermaid-block";

/** GitHub 默认 schema 之上，额外放行 code、pre 上的 language-* class，不然高亮/mermaid 用的 class 会被清掉 */
const SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    pre: [...(defaultSchema.attributes?.pre ?? []), ["className", /^language-/]],
  },
};

const MERMAID_LANGUAGE_CLASS = "language-mermaid";

function findCodeChild(node: Element | undefined): Element | undefined {
  return node?.children.find((c): c is Element => c.type === "element" && c.tagName === "code");
}

function isMermaidCode(code: Element | undefined): boolean {
  const className = code?.properties?.className;
  const classes = Array.isArray(className) ? className.map(String) : [];
  return classes.includes(MERMAID_LANGUAGE_CLASS);
}

/** `pre` 的自定义渲染：mermaid 代码块换成 `MermaidBlock`，其余原样输出 */
function PreBlock(props: ComponentProps<"pre"> & ExtraProps) {
  const { node, children, ...rest } = props;
  const code = findCodeChild(node);
  if (isMermaidCode(code)) {
    return <MermaidBlock code={hastToString(code!)} />;
  }
  return <pre {...rest}>{children}</pre>;
}

export interface DocMarkdownProps {
  /** 要渲染的 Markdown 源文本 */
  markdown: string;
  /** 这份内容在仓库里的路径，供链接改写解析相对路径 */
  currentPath: string;
  ctx: DocLinkCtx;
}

/** 渲染一份 Markdown；currentPath/ctx 用于把相对链接改写成站内文档页或 /raw 链接（见 lib/doc-links.ts） */
export function DocMarkdown({ markdown, currentPath, ctx }: DocMarkdownProps) {
  return (
    <div className="kh-doc-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        remarkRehypeOptions={{ allowDangerousHtml: true }}
        rehypePlugins={[rehypeRaw, rehypeSlug, [rehypeSanitize, SANITIZE_SCHEMA], () => rehypeDocLinks(currentPath, ctx), rehypeHighlight]}
        // react-markdown 默认的 urlTransform 只是简单转义/清一遍协议；这里改用管线里更严格的
        // rehype-sanitize（GitHub 协议白名单，在 rehypeDocLinks 之前就已经清掉危险协议）兜底，
        // 关掉默认实现是为了不让它在链接改写之后再次改写我们自己生成的站内相对路径。
        urlTransform={(url) => url}
        components={{ pre: PreBlock }}
      >
        {markdown}
      </Markdown>
    </div>
  );
}
