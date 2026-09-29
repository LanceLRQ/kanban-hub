import { describe, expect, it } from "vitest";
import { containerRefLabel, displayEmpty } from "./format";

describe("displayEmpty", () => {
  it("null 显示成（无）", () => {
    expect(displayEmpty(null)).toBe("（无）");
  });

  it("undefined 显示成（无）", () => {
    expect(displayEmpty(undefined)).toBe("（无）");
  });

  it("空字符串显示成（无）", () => {
    expect(displayEmpty("")).toBe("（无）");
  });

  it("非空字符串原样返回", () => {
    expect(displayEmpty("v1.0")).toBe("v1.0");
  });
});

describe("containerRefLabel", () => {
  const all = [{ id: "aaaa000001" }, { id: "bbbb000002" }];

  it("有编号用编号", () => {
    expect(containerRefLabel({ id: "aaaa000001", kind: "phase", code: "M1" }, all)).toBe("M1");
  });

  it("杂项容器固定显示 misc（即便自己有 code）", () => {
    expect(containerRefLabel({ id: "aaaa000001", kind: "misc", code: "misc" }, all)).toBe("misc");
    expect(containerRefLabel({ id: "aaaa000001", kind: "misc", code: null }, all)).toBe("misc");
  });

  it("非杂项容器没有编号时用整个看板范围内的最短唯一 ID 前缀，可以直接拿来引用", () => {
    const label = containerRefLabel({ id: "aaaa000001", kind: "phase", code: null }, all);
    expect(label).toBe("aaaa");
  });
});
