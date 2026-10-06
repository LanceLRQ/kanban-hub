import { describe, expect, it } from "vitest";
import type { TaskStatus } from "@kanban-hub/core/schema";
import type { BoardTaskView } from "@/server/views/board";
import {
  applyBoardView,
  boardViewStateSchema,
  DEFAULT_BOARD_VIEW,
  isDefaultBoardView,
  sectionVisible,
  tasksUnfiltered,
  type BoardStatusOption,
  type BoardViewState,
} from "./board-filter";

function task(id: string, status: TaskStatus, extra: { human?: boolean; createdAt?: string; updatedAt?: string } = {}): BoardTaskView {
  return {
    id,
    status,
    human: extra.human ? { kind: "decision", note: "n", since: "2026-10-01T00:00:00.000Z" } : null,
    createdAt: extra.createdAt ?? "2026-10-01T00:00:00.000Z",
    updatedAt: extra.updatedAt ?? "2026-10-01T00:00:00.000Z",
  } as unknown as BoardTaskView;
}

const ids = (tasks: BoardTaskView[]) => tasks.map((t) => t.id);
const view = (patch: Partial<BoardViewState>): BoardViewState => ({ ...DEFAULT_BOARD_VIEW, ...patch });
const byTask = (patch: Partial<BoardViewState>): BoardViewState => view({ filterMode: "task", ...patch });

const sample = [
  task("a", "done"),
  task("b", "todo", { human: true }),
  task("c", "in_progress"),
  task("d", "cancelled"),
  task("e", "review", { human: true }),
  task("f", "suspended"),
];

describe("applyBoardView 筛选", () => {
  const cases: Array<[string, Partial<BoardViewState>, string[]]> = [
    ["默认视图保持原顺序", {}, ["a", "b", "c", "d", "e", "f"]],
    ["空状态数组视同全部选中", { filterMode: "task", statuses: [] }, ["a", "b", "c", "d", "e", "f"]],
    ["单个状态", { filterMode: "task", statuses: ["todo"] }, ["b"]],
    ["多个状态", { filterMode: "task", statuses: ["done", "review"] }, ["a", "e"]],
    ["按里程碑筛选时任务状态不生效", { filterMode: "milestone", statuses: ["todo"] }, ["a", "b", "c", "d", "e", "f"]],
    ["按里程碑和任务：任务维度生效", { filterMode: "both", statuses: ["todo", "in_progress"] }, ["b", "c"]],
    ["任务维度忽略储备", { filterMode: "task", statuses: ["backlog", "done"] }, ["a"]],
    ["任务维度只剩储备时不筛任务", { filterMode: "task", statuses: ["backlog"] }, ["a", "b", "c", "d", "e", "f"]],
    ["全选（7 项）等同不筛", { filterMode: "task", statuses: ["todo", "in_progress", "review", "done", "backlog", "suspended", "cancelled"] }, ["a", "b", "c", "d", "e", "f"]],
    ["只看待你处理", { humanOnly: true }, ["b", "e"]],
    ["状态与待你处理叠加", { filterMode: "task", statuses: ["review"], humanOnly: true }, ["e"]],
    ["叠加后为空", { filterMode: "task", statuses: ["done"], humanOnly: true }, []],
  ];
  it.each(cases)("%s", (_name, patch, expected) => {
    expect(ids(applyBoardView(sample, view(patch)))).toEqual(expected);
  });

  it("不修改传入数组", () => {
    const copy = [...sample];
    applyBoardView(sample, view({ sort: "status" }));
    expect(sample).toEqual(copy);
  });
});

describe("applyBoardView 排序", () => {
  it("手动顺序保持原数组顺序，忽略方向", () => {
    expect(ids(applyBoardView(sample, view({ sort: "manual", direction: "asc" })))).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("状态排序：进行中 → 复核中 → 待开始 → 挂起 → 已完成 → 已取消", () => {
    expect(ids(applyBoardView(sample, view({ sort: "status" })))).toEqual(["c", "e", "b", "f", "a", "d"]);
  });

  it("状态排序忽略方向", () => {
    expect(ids(applyBoardView(sample, view({ sort: "status", direction: "asc" })))).toEqual(["c", "e", "b", "f", "a", "d"]);
  });

  it("状态相同时保持原顺序", () => {
    const tasks = [task("x", "todo"), task("y", "in_progress"), task("z", "todo"), task("w", "in_progress")];
    expect(ids(applyBoardView(tasks, view({ sort: "status" })))).toEqual(["y", "w", "x", "z"]);
  });

  const timed = [
    task("t1", "todo", { createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" }),
    task("t2", "todo", { createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z" }),
    task("t3", "todo", { createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" }),
  ];
  const timeCases: Array<[string, Partial<BoardViewState>, string[]]> = [
    ["最近更新，新的在前", { sort: "updated", direction: "desc" }, ["t2", "t3", "t1"]],
    ["最近更新，旧的在前", { sort: "updated", direction: "asc" }, ["t1", "t3", "t2"]],
    ["创建时间，新的在前", { sort: "created", direction: "desc" }, ["t3", "t1", "t2"]],
    ["创建时间，旧的在前", { sort: "created", direction: "asc" }, ["t2", "t1", "t3"]],
  ];
  it.each(timeCases)("%s", (_name, patch, expected) => {
    expect(ids(applyBoardView(timed, view(patch)))).toEqual(expected);
  });

  it("时间相同时两个方向都退回原顺序", () => {
    const same = [task("p", "todo"), task("q", "todo"), task("r", "todo")];
    expect(ids(applyBoardView(same, view({ sort: "updated", direction: "desc" })))).toEqual(["p", "q", "r"]);
    expect(ids(applyBoardView(same, view({ sort: "created", direction: "asc" })))).toEqual(["p", "q", "r"]);
  });

  it("先筛选再排序", () => {
    expect(ids(applyBoardView(sample, byTask({ statuses: ["todo", "in_progress", "done"], sort: "status" })))).toEqual(["c", "b", "a"]);
  });
});

const section = (status: BoardStatusOption | null) => ({ status }) as Parameters<typeof sectionVisible>[0];

describe("sectionVisible", () => {
  const cases: Array<[string, Partial<BoardViewState>, Parameters<typeof section>[0], boolean]> = [
    ["没选状态：都显示", {}, "done", true],
    ["按里程碑：状态在集合里", { statuses: ["done"] }, "done", true],
    ["按里程碑：状态不在集合里", { statuses: ["done"] }, "todo", false],
    ["按里程碑和任务：同样筛里程碑", { filterMode: "both", statuses: ["done"] }, "todo", false],
    ["按任务：里程碑都保留", { filterMode: "task", statuses: ["done"] }, "todo", true],
    ["杂项（无状态）始终显示", { statuses: ["done"] }, null, true],
    ["里程碑维度忽略复核中：只剩复核中时不筛", { statuses: ["review"] }, "todo", true],
    ["里程碑维度忽略复核中：其余项照常", { statuses: ["review", "backlog"] }, "todo", false],
    ["储备可筛里程碑", { statuses: ["backlog"] }, "backlog", true],
    ["全选等同不筛", { statuses: ["todo", "in_progress", "review", "done", "backlog", "suspended", "cancelled"] }, "todo", true],
  ];
  it.each(cases)("%s", (_n, patch, status, expected) => {
    expect(sectionVisible(section(status), view(patch))).toBe(expected);
  });
});

describe("isDefaultBoardView、tasksUnfiltered 与 schema", () => {
  it("默认值是默认视图", () => {
    expect(isDefaultBoardView(DEFAULT_BOARD_VIEW)).toBe(true);
    expect(tasksUnfiltered(DEFAULT_BOARD_VIEW)).toBe(true);
  });
  it("空状态数组仍视为默认", () => {
    expect(isDefaultBoardView(view({ statuses: [] }))).toBe(true);
  });
  it("七个状态全选也视为默认", () => {
    expect(isDefaultBoardView(view({ statuses: ["todo", "in_progress", "review", "done", "backlog", "suspended", "cancelled"] }))).toBe(true);
  });
  it.each<[string, Partial<BoardViewState>]>([
    ["筛状态", { statuses: ["todo"] }],
    ["待你处理", { humanOnly: true }],
    ["排序", { sort: "status" }],
  ])("偏离默认：%s", (_n, patch) => {
    expect(isDefaultBoardView(view(patch))).toBe(false);
  });
  it("没有选状态时筛选方式不算偏离", () => {
    expect(isDefaultBoardView(view({ filterMode: "both" }))).toBe(true);
  });
  it("手动顺序下方向不影响是否默认", () => {
    expect(isDefaultBoardView(view({ direction: "asc" }))).toBe(true);
  });
  const taskCases: Array<[string, Partial<BoardViewState>, boolean]> = [
    ["只按里程碑筛选：任务没被筛", { statuses: ["todo"] }, true],
    ["按里程碑筛选且只选了储备：任务没被筛", { filterMode: "task", statuses: ["backlog"] }, true],
    ["按任务筛选：任务被筛", { filterMode: "task", statuses: ["todo"] }, false],
    ["按里程碑和任务：任务被筛", { filterMode: "both", statuses: ["todo"] }, false],
    ["待你处理", { humanOnly: true }, false],
    ["非手动排序", { sort: "updated" }, false],
  ];
  it.each(taskCases)("tasksUnfiltered：%s", (_n, patch, expected) => {
    expect(tasksUnfiltered(view(patch))).toBe(expected);
  });
  it("schema 接受默认值，拒绝非法值", () => {
    expect(boardViewStateSchema.safeParse(DEFAULT_BOARD_VIEW).success).toBe(true);
    expect(boardViewStateSchema.safeParse({ ...DEFAULT_BOARD_VIEW, sort: "bogus" }).success).toBe(false);
    expect(boardViewStateSchema.safeParse({ ...DEFAULT_BOARD_VIEW, statuses: ["nope"] }).success).toBe(false);
    expect(boardViewStateSchema.safeParse({ ...DEFAULT_BOARD_VIEW, filterMode: "x" }).success).toBe(false);
  });
  it("旧存值（无 filterMode、只有任务状态）仍能解析，筛选方式取默认", () => {
    const parsed = boardViewStateSchema.parse({ statuses: ["todo"], humanOnly: false, sort: "manual", direction: "desc" });
    expect(parsed.filterMode).toBe("milestone");
    expect(parsed.statuses).toEqual(["todo"]);
  });
  it("statuses 接受储备", () => {
    expect(boardViewStateSchema.safeParse({ ...DEFAULT_BOARD_VIEW, statuses: ["backlog"] }).success).toBe(true);
  });
});
