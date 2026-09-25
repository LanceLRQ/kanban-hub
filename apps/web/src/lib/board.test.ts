import { describe, expect, it } from "vitest";
import { fixtureId, makeBoard, makeContainer, makeTask } from "@kanban-hub/core/test-fixtures";
import { boardSections, taskMeta } from "./board";

const c = (n: number) => fixtureId("c", n);
const t = (n: number) => fixtureId("t", n);

describe("boardSections", () => {
  it("阶段和特性按 order 排列，储备在其后，杂项最后", () => {
    const board = makeBoard([
      makeContainer({ id: c(1), kind: "phase", code: "M2", order: 2 }),
      makeContainer({ id: c(2), kind: "feature", code: null, title: "特性", order: 1 }),
      makeContainer({ id: c(3), kind: "phase", code: "M9", order: 0, manualStatus: "backlog" }),
      makeContainer({ id: c(4), kind: "phase", code: "M1", order: 0 }),
      makeContainer({ id: c(5), kind: "feature", code: null, title: "储备二", order: 5, manualStatus: "backlog" }),
    ]);
    expect(boardSections(board).map((s) => s.container.id)).toEqual([c(4), c(2), c(1), c(3), c(5), fixtureId("c", 0)]);
  });

  it("挂起、已取消的容器留在原位，状态来自手动设置", () => {
    const board = makeBoard([
      makeContainer({ id: c(1), order: 0 }),
      makeContainer({ id: c(2), order: 1, manualStatus: "suspended", manualReason: "等上游" }),
      makeContainer({ id: c(3), order: 2, manualStatus: "cancelled" }),
      makeContainer({ id: c(4), order: 3 }),
    ]);
    const sections = boardSections(board);
    expect(sections.map((s) => s.container.id)).toEqual([c(1), c(2), c(3), c(4), fixtureId("c", 0)]);
    expect(sections[1]!.summary.status).toBe("suspended");
    expect(sections[2]!.summary.status).toBe("cancelled");
    expect(sections[1]!.collapsed).toBe(false);
    expect(sections[2]!.collapsed).toBe(false);
  });

  it("已完成的容器默认折叠；已取消的任务不计入任务数，另记个数", () => {
    const board = makeBoard(
      [makeContainer({ id: c(1), order: 0 }), makeContainer({ id: c(2), order: 1 })],
      [
        makeTask({ id: t(1), containerId: c(1), status: "done", completedAt: "2026-09-20T03:00:00.000Z" }),
        makeTask({ id: t(2), containerId: c(1), status: "done", completedAt: "2026-09-18T03:00:00.000Z" }),
        makeTask({ id: t(3), containerId: c(1), status: "cancelled" }),
        makeTask({ id: t(4), containerId: c(2), status: "in_progress" }),
      ],
    );
    const [done, doing] = boardSections(board);
    expect(done!.collapsed).toBe(true);
    expect(done!.summary.status).toBe("done");
    expect(done!.summary.progress).toEqual({ done: 2, total: 2 });
    expect(done!.cancelledCount).toBe(1);
    expect(done!.summary.completedAt).toBe("2026-09-20T03:00:00.000Z");
    expect(done!.tasks).toHaveLength(3);
    expect(doing!.collapsed).toBe(false);
    expect(doing!.cancelledCount).toBe(0);
  });

  it("杂项容器不推算状态、不折叠，给出未完成数", () => {
    const board = makeBoard(
      [],
      [
        makeTask({ id: t(1), containerId: fixtureId("c", 0), status: "done", completedAt: "2026-09-20T03:00:00.000Z" }),
        makeTask({ id: t(2), containerId: fixtureId("c", 0), status: "in_progress" }),
        makeTask({ id: t(3), containerId: fixtureId("c", 0), status: "todo" }),
        makeTask({ id: t(4), containerId: fixtureId("c", 0), status: "cancelled" }),
      ],
    );
    const misc = boardSections(board).at(-1)!;
    expect(misc.container.kind).toBe("misc");
    expect(misc.summary.status).toBeNull();
    expect(misc.summary.openCount).toBe(2);
    expect(misc.collapsed).toBe(false);
  });

  it("容器内的任务按 order 排列", () => {
    const board = makeBoard(
      [makeContainer({ id: c(1) })],
      [
        makeTask({ id: t(1), containerId: c(1), order: 2 }),
        makeTask({ id: t(2), containerId: c(1), order: 0 }),
        makeTask({ id: t(3), containerId: c(1), order: 1 }),
      ],
    );
    expect(boardSections(board)[0]!.tasks.map((x) => x.id)).toEqual([t(2), t(3), t(1)]);
  });
});

describe("taskMeta", () => {
  const TZ = "Asia/Shanghai";
  const NOW = new Date("2026-09-24T04:00:00.000Z"); // 上海 9 月 24 日 12:00

  it("已完成优先：完成于 M 月 D 日", () => {
    const meta = taskMeta(
      makeTask({ status: "done", completedAt: "2026-09-21T02:00:00.000Z", dueDate: "2026-09-28", checklist: [{ text: "a", done: true }] }),
      NOW,
      TZ,
    );
    expect(meta.main).toEqual({ kind: "completed", date: "9 月 21 日" });
  });

  it("未完成、有截止日期：截止 M 月 D 日（优先于进行中和清单）", () => {
    const meta = taskMeta(
      makeTask({ status: "in_progress", startedAt: "2026-09-22T02:00:00.000Z", dueDate: "2026-09-28", checklist: [{ text: "a", done: false }] }),
      NOW,
      TZ,
    );
    expect(meta.main).toEqual({ kind: "due", date: "9 月 28 日" });
  });

  it("进行中：开始于 M 月 D 日；当天写开始于今天", () => {
    expect(taskMeta(makeTask({ status: "in_progress", startedAt: "2026-09-22T02:00:00.000Z" }), NOW, TZ).main).toEqual({
      kind: "started",
      date: "9 月 22 日",
    });
    expect(taskMeta(makeTask({ status: "in_progress", startedAt: "2026-09-24T01:00:00.000Z" }), NOW, TZ).main).toEqual({
      kind: "startedToday",
    });
  });

  it("有清单：清单 a/b（优先级最低）", () => {
    const meta = taskMeta(
      makeTask({
        status: "review",
        startedAt: "2026-09-22T02:00:00.000Z",
        checklist: [
          { text: "a", done: true },
          { text: "b", done: false },
        ],
      }),
      NOW,
      TZ,
    );
    expect(meta.main).toEqual({ kind: "checklist", done: 1, total: 2 });
  });

  it("都不满足时没有右侧主信息", () => {
    expect(taskMeta(makeTask({ status: "todo" }), NOW, TZ).main).toBeNull();
  });

  it("备注取第一行非空文字；分组与关联文档原样带出", () => {
    const meta = taskMeta(makeTask({ note: "\n  等你拍板后全量替换  \n第二行", group: "安全", docRefs: ["docs/a.md"] }), NOW, TZ);
    expect(meta.note).toBe("等你拍板后全量替换");
    expect(meta.group).toBe("安全");
    expect(meta.docRefs).toEqual(["docs/a.md"]);
    expect(taskMeta(makeTask({ note: "  " }), NOW, TZ).note).toBeNull();
  });

  it("时间戳按传入的时区换算日期：UTC 前一天深夜在上海已是次日", () => {
    const task = makeTask({ status: "done", completedAt: "2026-09-20T17:30:00.000Z" });
    expect(taskMeta(task, NOW, "Asia/Shanghai").main).toEqual({ kind: "completed", date: "9 月 21 日" });
    expect(taskMeta(task, NOW, "UTC").main).toEqual({ kind: "completed", date: "9 月 20 日" });
  });

  it("“今天”按传入时区的自然日判断", () => {
    // 上海 9 月 24 日 00:30 开始；此刻上海 9 月 24 日 12:00 → 今天；换成洛杉矶时区，开始时是 9 月 23 日，此刻是 9 月 23 日 21:00 → 也是今天
    const task = makeTask({ status: "in_progress", startedAt: "2026-09-23T16:30:00.000Z" });
    expect(taskMeta(task, NOW, "Asia/Shanghai").main).toEqual({ kind: "startedToday" });
    expect(taskMeta(task, NOW, "America/Los_Angeles").main).toEqual({ kind: "startedToday" });
    expect(taskMeta(task, NOW, "UTC").main).toEqual({ kind: "started", date: "9 月 23 日" });
  });

  it("截止日期是纯日期，不随时区偏移", () => {
    const task = makeTask({ status: "todo", dueDate: "2026-09-28" });
    expect(taskMeta(task, NOW, "America/Los_Angeles").main).toEqual({ kind: "due", date: "9 月 28 日" });
    expect(taskMeta(task, NOW, "Pacific/Kiritimati").main).toEqual({ kind: "due", date: "9 月 28 日" });
  });
});
