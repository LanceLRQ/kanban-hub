import { describe, expect, it } from "vitest";
import { resolveDocLink, type DocLinkCtx } from "./doc-links";

function ctx(existing: readonly string[]): DocLinkCtx {
  const set = new Set(existing);
  return {
    exists: (p) => set.has(p),
    docHref: (p, hash) => `/docs/${p}${hash ? `#${hash}` : ""}`,
    rawHref: (p) => `/raw/${p}`,
  };
}

describe("resolveDocLink", () => {
  it("相对路径解析到当前文件所在目录", () => {
    const c = ctx(["docs/a.md", "docs/b.md"]);
    expect(resolveDocLink("b.md", "docs/a.md", c)).toEqual({ kind: "doc", href: "/docs/docs/b.md" });
  });

  it("../ 向上一级解析", () => {
    const c = ctx(["README.md"]);
    expect(resolveDocLink("../README.md", "docs/a.md", c)).toEqual({ kind: "doc", href: "/docs/README.md" });
  });

  it("以 / 开头按仓库根解析", () => {
    const c = ctx(["docs/spec.md"]);
    expect(resolveDocLink("/docs/spec.md", "other/current.md", c)).toEqual({ kind: "doc", href: "/docs/docs/spec.md" });
  });

  it("带 #锚点：保留锚点，传给 docHref", () => {
    const c = ctx(["docs/a.md"]);
    expect(resolveDocLink("a.md#section-1", "docs/current.md", c)).toEqual({
      kind: "doc",
      href: "/docs/docs/a.md#section-1",
    });
  });

  it("目标不在清单里返回 missing", () => {
    const c = ctx([]);
    expect(resolveDocLink("missing.md", "docs/a.md", c)).toEqual({ kind: "missing" });
  });

  it("http(s) 链接原样保留为 external", () => {
    const c = ctx([]);
    expect(resolveDocLink("https://example.com/x", "docs/a.md", c)).toEqual({
      kind: "external",
      href: "https://example.com/x",
    });
  });

  it("mailto 链接原样保留为 external", () => {
    const c = ctx([]);
    expect(resolveDocLink("mailto:a@example.com", "docs/a.md", c)).toEqual({
      kind: "external",
      href: "mailto:a@example.com",
    });
  });

  it("javascript: 协议丢弃", () => {
    const c = ctx([]);
    expect(resolveDocLink("javascript:alert(1)", "docs/a.md", c)).toEqual({ kind: "drop" });
  });

  it("目标是清单里的非 Markdown 文件（如图片）改写为 raw", () => {
    const c = ctx(["docs/diagram.png"]);
    expect(resolveDocLink("diagram.png", "docs/a.md", c)).toEqual({ kind: "raw", href: "/raw/docs/diagram.png" });
  });

  it("中文和空格路径能正确编码往返", () => {
    const c = ctx(["docs/中文 笔记.md"]);
    expect(resolveDocLink("%E4%B8%AD%E6%96%87%20%E7%AC%94%E8%AE%B0.md", "docs/a.md", c)).toEqual({
      kind: "doc",
      href: "/docs/docs/中文 笔记.md",
    });
  });

  it("文件名里带字面 # 的路径，编码后能正确往返", () => {
    const c = ctx(["docs/a#b.md"]);
    expect(resolveDocLink("a%23b.md", "docs/current.md", c)).toEqual({ kind: "doc", href: "/docs/docs/a#b.md" });
  });

  it("文件名里带字面 ? 的路径，能正确往返", () => {
    const c = ctx(["docs/a?b.md"]);
    expect(resolveDocLink("a?b.md", "docs/current.md", c)).toEqual({ kind: "doc", href: "/docs/docs/a?b.md" });
  });

  it("文件名里带字面 % 的路径，编码后能正确往返", () => {
    const c = ctx(["docs/100%.md"]);
    expect(resolveDocLink("100%25.md", "docs/current.md", c)).toEqual({ kind: "doc", href: "/docs/docs/100%.md" });
  });
});
