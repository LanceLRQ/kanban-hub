import { describe, expect, it } from "vitest";
import { buildDocTree } from "./doc-tree";
import { allDirPaths, ancestorDirs, compileMatcher, filterTree, highlightRange } from "./doc-tree-filter";

const tree = buildDocTree(["README.md", "docs/guide/intro.md", "docs/guide/Setup.md", "docs/api.md", "src/lib/a.ts"]);

function matcher(query: string, regex = false) {
  const m = compileMatcher(query, regex);
  if (!m.ok || !m.test) throw new Error("matcher 不可用");
  return m.test;
}

describe("ancestorDirs", () => {
  it.each([
    ["README.md", []],
    ["docs/api.md", ["docs"]],
    ["a/b/c/d.md", ["a", "a/b", "a/b/c"]],
  ])("%s", (path, expected) => {
    expect(ancestorDirs(path)).toEqual(expected);
  });
});

describe("allDirPaths", () => {
  it("收集所有层级的目录路径", () => {
    expect(allDirPaths(tree).sort()).toEqual(["docs", "docs/guide", "src", "src/lib"]);
  });
});

describe("compileMatcher", () => {
  it("空查询表示不筛选", () => {
    expect(compileMatcher("", false)).toEqual({ ok: true, test: null });
    expect(compileMatcher("", true)).toEqual({ ok: true, test: null });
  });

  it.each([
    ["子串不分大小写", "SETUP", false, "docs/guide/setup.md", true],
    ["按目录名匹配", "guide", false, "docs/guide/intro.md", true],
    ["子串里的正则符号按字面", "a.b", false, "a-b.md", false],
    ["子串未命中", "xyz", false, "docs/api.md", false],
    ["正则匹配", "^docs/.*\\.md$", true, "docs/api.md", true],
    ["正则不分大小写", "SETUP", true, "docs/guide/setup.md", true],
    ["正则未命中", "^src", true, "docs/api.md", false],
  ])("%s", (_name, query, regex, path, expected) => {
    expect(matcher(query, regex)(path)).toBe(expected);
  });

  it("无效正则返回 ok: false", () => {
    expect(compileMatcher("(", true)).toEqual({ ok: false });
    expect(compileMatcher("(", false).ok).toBe(true);
  });
});

describe("filterTree", () => {
  it("只保留命中的文件与祖先目录，并计数", () => {
    const result = filterTree(tree, matcher("guide"));
    expect(result.count).toBe(2);
    expect(result.nodes.map((n) => n.path)).toEqual(["docs"]);
    const docs = result.nodes[0]!;
    if (docs.type !== "dir") throw new Error("应为目录");
    expect(docs.children.map((c) => c.path)).toEqual(["docs/guide"]);
  });

  it("目录没有命中文件时整体去掉", () => {
    const result = filterTree(tree, matcher("README"));
    expect(result.count).toBe(1);
    expect(result.nodes.map((n) => n.path)).toEqual(["README.md"]);
  });

  it("没有命中时为空", () => {
    expect(filterTree(tree, matcher("nope"))).toEqual({ nodes: [], count: 0 });
  });
});

describe("highlightRange", () => {
  it.each([
    ["子串", "intro.md", "RO", false, [3, 5]],
    ["未命中", "intro.md", "zzz", false, null],
    ["空查询", "intro.md", "", false, null],
    ["正则", "intro.md", "r.", true, [3, 5]],
    ["无效正则", "intro.md", "(", true, null],
    ["空匹配不高亮", "intro.md", "x*", true, null],
  ] as const)("%s", (_name, name, query, regex, expected) => {
    expect(highlightRange(name, query, regex)).toEqual(expected);
  });
});
