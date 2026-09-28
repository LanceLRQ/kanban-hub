import { describe, expect, it } from "vitest";
import { buildDocTree } from "./doc-tree";

describe("buildDocTree", () => {
  it("由路径列表构造树，同一层目录排在文件前面，各自按名称排序", () => {
    const tree = buildDocTree(["README.md", "docs/csp-notes.md", "docs/backup-plan.md", "a.md"]);
    expect(tree).toEqual([
      {
        type: "dir",
        name: "docs",
        path: "docs",
        children: [
          { type: "file", name: "backup-plan.md", path: "docs/backup-plan.md" },
          { type: "file", name: "csp-notes.md", path: "docs/csp-notes.md" },
        ],
      },
      { type: "file", name: "README.md", path: "README.md" },
      { type: "file", name: "a.md", path: "a.md" },
    ]);
  });

  it("多层嵌套目录", () => {
    const tree = buildDocTree(["docs/specs/design.md", "docs/readme.md"]);
    expect(tree).toEqual([
      {
        type: "dir",
        name: "docs",
        path: "docs",
        children: [
          {
            type: "dir",
            name: "specs",
            path: "docs/specs",
            children: [{ type: "file", name: "design.md", path: "docs/specs/design.md" }],
          },
          { type: "file", name: "readme.md", path: "docs/readme.md" },
        ],
      },
    ]);
  });

  it("空列表返回空树", () => {
    expect(buildDocTree([])).toEqual([]);
  });
});
