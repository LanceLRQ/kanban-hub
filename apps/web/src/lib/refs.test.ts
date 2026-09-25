import { describe, expect, it } from "vitest";
import { fixtureId, makeBoard, makeContainer, makeMisc, makeTask } from "@kanban-hub/core/test-fixtures";
import { containerRefLabel, taskShortRef } from "./refs";

describe("taskShortRef", () => {
  it("用 # 加整个看板范围内能互相区分的最短前缀（至少 4 位）", () => {
    const board = makeBoard([], [makeTask({ id: "aaaa000001" }), makeTask({ id: "bbbb000001" })]);
    expect(taskShortRef(board, "aaaa000001")).toBe("#aaaa");
  });

  it("任务不在看板里时，用传入的完整 ID 兜底", () => {
    const board = makeBoard([], [makeTask({ id: fixtureId("t", 1) })]);
    expect(taskShortRef(board, "zzzzzzzzzz")).toBe("#zzzzzzzzzz");
  });
});

describe("containerRefLabel", () => {
  const misc = makeMisc();

  it("有编号时用编号", () => {
    const container = makeContainer({ code: "M1" });
    expect(containerRefLabel(container, [container, misc])).toBe("M1");
  });

  it("杂项容器固定显示 misc", () => {
    expect(containerRefLabel(misc, [misc])).toBe("misc");
  });

  it("没有编号、不是杂项时，用最短唯一 ID 前缀", () => {
    const a = makeContainer({ id: "aaaa000001", code: null });
    const b = makeContainer({ id: "bbbb000001", code: null });
    expect(containerRefLabel(a, [a, b, misc])).toBe("aaaa");
  });
});
