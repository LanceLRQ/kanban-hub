import { describe, expect, it } from "vitest";
import { decodeDocPathParam, encodeDocPath } from "./doc-url";

describe("decodeDocPathParam", () => {
  it("没有路径段时返回 undefined（文档首页）", () => {
    expect(decodeDocPathParam(undefined)).toBeUndefined();
    expect(decodeDocPathParam([])).toBeUndefined();
  });

  it("逐段解码页面拿到的原始路径段：中文文件名能对上快照里的路径", () => {
    expect(decodeDocPathParam(["docs", "plans", "2026-09-21-HF%E6%A8%A1%E5%9E%8B%E5%8F%91%E7%8E%B0.md"])).toBe(
      "docs/plans/2026-09-21-HF模型发现.md",
    );
  });

  it("与 encodeDocPath 往返：中文、空格、#、?、% 都还原成原路径", () => {
    for (const path of ["README.md", "docs/设计 草稿/a#b?c.md", "notes/100%.md", "docs/_internal/TASKS.md"]) {
      expect(decodeDocPathParam(encodeDocPath(path).split("/"))).toBe(path);
    }
  });

  it("不是合法百分号编码的段原样保留，不抛错", () => {
    expect(decodeDocPathParam(["docs", "%E6bad.md"])).toBe("docs/%E6bad.md");
  });
});
