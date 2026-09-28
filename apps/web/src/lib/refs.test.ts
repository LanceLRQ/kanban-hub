import { describe, expect, it } from "vitest";
import { fixtureId, makeBoard, makeContainer, makeMisc, makeTask } from "@kanban-hub/core/test-fixtures";
import { containerRefLabel, taskShortRef, taskShortRefTable } from "./refs";

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

describe("taskShortRefTable", () => {
  const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

  function randomId(): string {
    const len = 4 + Math.floor(Math.random() * 6);
    let id = "";
    for (let i = 0; i < len; i++) id += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return id;
  }

  /** 故意让部分 ID 共享前缀（同一个随机基底加不同后缀），多制造需要往后找区分位的情况 */
  function randomIds(count: number): string[] {
    const ids = new Set<string>();
    while (ids.size < count) {
      const base = randomId();
      ids.add(Math.random() < 0.5 ? base : `${base}${randomId()}`);
    }
    return [...ids];
  }

  it("与逐个调用 taskShortRef 的结果完全一致（随机生成的看板上做对照）", () => {
    for (let round = 0; round < 20; round++) {
      const ids = randomIds(1 + Math.floor(Math.random() * 30));
      const board = makeBoard(
        [],
        ids.map((id) => makeTask({ id })),
      );
      const table = taskShortRefTable(board);
      for (const id of ids) {
        expect(table.get(id)).toBe(taskShortRef(board, id));
      }
    }
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
