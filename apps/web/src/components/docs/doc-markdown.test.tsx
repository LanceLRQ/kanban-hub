import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DocMarkdown } from "./doc-markdown";
import type { DocLinkCtx } from "@/lib/doc-links";

/**
 * `DocMarkdown` 是服务端组件，渲染出的是 React 元素树，不是字符串——生产代码里从不需要
 * 把它转成字符串。这里用 `react-dom/server` 把结果转成 HTML 做断言，只是测试手段。
 */
function render(markdown: string, currentPath: string, ctx: DocLinkCtx): string {
  return renderToStaticMarkup(<DocMarkdown markdown={markdown} currentPath={currentPath} ctx={ctx} />);
}

const NOOP_CTX: DocLinkCtx = {
  exists: () => false,
  docHref: (p) => `/docs/${p}`,
  rawHref: (p) => `/raw/${p}`,
};

describe("DocMarkdown", () => {
  it("清掉 <script> 标签", () => {
    const html = render("正文\n\n<script>alert(1)</script>", "a.md", NOOP_CTX);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
  });

  it("清掉 onerror= 之类的事件属性", () => {
    const html = render('<img src="x.png" onerror="alert(1)">', "a.md", NOOP_CTX);
    expect(html).not.toContain("onerror");
  });

  it("清掉 javascript: 链接", () => {
    const html = render("[点我](javascript:alert(1))", "a.md", NOOP_CTX);
    expect(html).not.toContain("javascript:");
  });

  it("language-ts 的代码块带高亮 class", () => {
    const html = render("```ts\nconst a: number = 1;\n```", "a.md", NOOP_CTX);
    expect(html).toContain("language-ts");
    expect(html).toContain("hljs");
  });

  it("GFM 表格与任务列表正常渲染", () => {
    const html = render("| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo", "a.md", NOOP_CTX);
    expect(html).toContain("<table>");
    expect(html).toContain('type="checkbox"');
  });

  it("相对链接被改写", () => {
    const ctx: DocLinkCtx = {
      exists: (p) => p === "docs/b.md",
      docHref: (p) => `/docs/${p}`,
      rawHref: (p) => `/raw/${p}`,
    };
    const html = render("[链接](b.md)", "docs/a.md", ctx);
    expect(html).toContain('href="/docs/docs/b.md"');
  });

  it("mermaid 代码块渲染成占位容器，不在服务端执行 mermaid", () => {
    const html = render("```mermaid\ngraph TD;A-->B;\n```", "a.md", NOOP_CTX);
    expect(html).toContain("kh-mermaid");
    expect(html).not.toContain("<svg");
    // 静态渲染阶段客户端组件的 useEffect 不会运行，原始代码不会出现在服务端输出里
    expect(html).not.toContain("graph TD");
  });
});
