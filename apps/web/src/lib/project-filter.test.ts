import { describe, expect, it } from "vitest";
import type { Progress } from "@kanban-hub/core/derive";
import type { Cycle, Health } from "@kanban-hub/core/schema";
import {
  DEFAULT_PROJECTS_VIEW,
  applyProjectsView,
  isDefaultProjectsView,
  progressBucket,
  projectsViewStateSchema,
  type ProjectFilterMeta,
  type ProjectsViewState,
} from "./project-filter";

function meta(id: string, extra: Partial<Omit<ProjectFilterMeta, "id">> = {}): ProjectFilterMeta {
  return {
    id,
    cycle: "development" as Cycle,
    health: "on_track" as Health,
    progress: { done: 0, total: 0 } as Progress,
    createdAt: "2026-10-01T00:00:00.000Z",
    lastEventAt: null,
    ...extra,
  };
}

const view = (extra: Partial<ProjectsViewState> = {}): ProjectsViewState => ({ ...DEFAULT_PROJECTS_VIEW, ...extra });
const ids = (items: ProjectFilterMeta[]) => items.map((i) => i.id);

describe("progressBucket", () => {
  it.each([
    [0, 0, "not_started"],
    [0, 5, "not_started"],
    [1, 5, "in_progress"],
    [4, 5, "in_progress"],
    [5, 5, "done"],
  ] as const)("%i/%i 归入 %s", (done, total, expected) => {
    expect(progressBucket({ done, total })).toBe(expected);
  });
});

describe("默认视图", () => {
  it("周期默认是除归档以外的四项，其余不筛选，按最近活动倒序", () => {
    expect(DEFAULT_PROJECTS_VIEW).toEqual({
      cycles: ["design", "development", "iteration", "maintenance"],
      healths: [],
      progress: "all",
      sort: "activity",
      direction: "desc",
    });
    expect(isDefaultProjectsView(DEFAULT_PROJECTS_VIEW)).toBe(true);
    expect(isDefaultProjectsView(view({ progress: "done" }))).toBe(false);
    expect(isDefaultProjectsView(view({ direction: "asc" }))).toBe(false);
    expect(isDefaultProjectsView(view({ cycles: [] }))).toBe(false);
  });

  it("schema 校验通过默认值，拒绝非法值", () => {
    expect(projectsViewStateSchema.safeParse(DEFAULT_PROJECTS_VIEW).success).toBe(true);
    expect(projectsViewStateSchema.safeParse({ ...DEFAULT_PROJECTS_VIEW, sort: "x" }).success).toBe(false);
  });
});

describe("筛选", () => {
  const items = [
    meta("a", { cycle: "design", health: "blocked", progress: { done: 0, total: 3 } }),
    meta("b", { cycle: "development", health: "at_risk", progress: { done: 1, total: 3 } }),
    meta("c", { cycle: "archived", health: "on_track", progress: { done: 3, total: 3 } }),
    meta("d", { cycle: "development", health: "on_track", progress: { done: 3, total: 3 } }),
  ];

  it("默认隐藏归档", () => {
    expect(ids(applyProjectsView(items, view()))).toEqual(["a", "b", "d"]);
  });

  it("勾选归档后出现，并排在最后", () => {
    const state = view({ cycles: [...DEFAULT_PROJECTS_VIEW.cycles, "archived"] });
    expect(ids(applyProjectsView(items, state))).toEqual(["a", "b", "d", "c"]);
  });

  it("cycles 或 healths 为空数组视同全部选中", () => {
    expect(ids(applyProjectsView(items, view({ cycles: [] })))).toEqual(["a", "b", "d", "c"]);
    expect(ids(applyProjectsView(items, view({ healths: [] })))).toEqual(["a", "b", "d"]);
  });

  it.each([
    [{ healths: ["blocked"] }, ["a"]],
    [{ healths: ["blocked", "on_track"] }, ["a", "d"]],
    [{ progress: "not_started" }, ["a"]],
    [{ progress: "in_progress" }, ["b"]],
    [{ progress: "done" }, ["d"]],
    [{ cycles: ["development"], healths: ["on_track", "at_risk"], progress: "done" }, ["d"]],
    [{ cycles: ["design"], progress: "done" }, []],
  ] as [Partial<ProjectsViewState>, string[]][])("组合 %j", (extra, expected) => {
    expect(ids(applyProjectsView(items, view(extra)))).toEqual(expected);
  });
});

describe("排序", () => {
  const all = (extra: Partial<ProjectsViewState>) => view({ cycles: [], ...extra });

  it("最近活动：倒序时新的在前，没有事件的排在同组最后", () => {
    const items = [
      meta("none"),
      meta("old", { lastEventAt: "2026-10-01T00:00:00.000Z" }),
      meta("new", { lastEventAt: "2026-10-02T00:00:00.000Z" }),
    ];
    expect(ids(applyProjectsView(items, all({})))).toEqual(["new", "old", "none"]);
  });

  it("最近活动：正序时旧的在前，没有事件的仍排在最后", () => {
    const items = [
      meta("none"),
      meta("new", { lastEventAt: "2026-10-02T00:00:00.000Z" }),
      meta("old", { lastEventAt: "2026-10-01T00:00:00.000Z" }),
    ];
    expect(ids(applyProjectsView(items, all({ direction: "asc" })))).toEqual(["old", "new", "none"]);
  });

  it("创建时间：倒序新的在前，正序旧的在前", () => {
    const items = [
      meta("m", { createdAt: "2026-10-02T00:00:00.000Z" }),
      meta("o", { createdAt: "2026-10-01T00:00:00.000Z" }),
      meta("n", { createdAt: "2026-10-03T00:00:00.000Z" }),
    ];
    expect(ids(applyProjectsView(items, all({ sort: "created" })))).toEqual(["n", "m", "o"]);
    expect(ids(applyProjectsView(items, all({ sort: "created", direction: "asc" })))).toEqual(["o", "m", "n"]);
  });

  it("进度百分比：倒序高的在前；同一百分比内按最近活动倒序", () => {
    const items = [
      meta("low", { progress: { done: 1, total: 4 } }),
      meta("zero-old", { progress: { done: 0, total: 0 }, lastEventAt: "2026-10-01T00:00:00.000Z" }),
      meta("zero-new", { progress: { done: 0, total: 5 }, lastEventAt: "2026-10-02T00:00:00.000Z" }),
      meta("half", { progress: { done: 2, total: 4 } }),
    ];
    expect(ids(applyProjectsView(items, all({ sort: "progress" })))).toEqual(["half", "low", "zero-new", "zero-old"]);
    expect(ids(applyProjectsView(items, all({ sort: "progress", direction: "asc" })))).toEqual(["zero-new", "zero-old", "low", "half"]);
  });

  it("健康度：倒序（默认）卡住 → 有风险 → 正常；正序反过来；同档内按最近活动倒序", () => {
    const items = [
      meta("ok-old", { health: "on_track", lastEventAt: "2026-10-01T00:00:00.000Z" }),
      meta("risk", { health: "at_risk" }),
      meta("blocked", { health: "blocked" }),
      meta("ok-new", { health: "on_track", lastEventAt: "2026-10-02T00:00:00.000Z" }),
    ];
    expect(ids(applyProjectsView(items, all({ sort: "health" })))).toEqual(["blocked", "risk", "ok-new", "ok-old"]);
    expect(ids(applyProjectsView(items, all({ sort: "health", direction: "asc" })))).toEqual(["ok-new", "ok-old", "risk", "blocked"]);
  });

  it.each(["activity", "created", "progress", "health"] as const)("%s 排序下归档项目整体排在最后，内部套用同一排序", (sort) => {
    const items = [
      meta("arch-new", { cycle: "archived", createdAt: "2026-10-05T00:00:00.000Z", lastEventAt: "2026-10-05T00:00:00.000Z", health: "blocked", progress: { done: 5, total: 5 } }),
      meta("arch-old", { cycle: "archived", createdAt: "2026-09-05T00:00:00.000Z", lastEventAt: "2026-09-05T00:00:00.000Z", health: "on_track", progress: { done: 0, total: 5 } }),
      meta("live-old", { createdAt: "2026-09-01T00:00:00.000Z", lastEventAt: "2026-09-01T00:00:00.000Z", health: "on_track", progress: { done: 0, total: 5 } }),
      meta("live-new", { createdAt: "2026-10-01T00:00:00.000Z", lastEventAt: "2026-10-01T00:00:00.000Z", health: "blocked", progress: { done: 5, total: 5 } }),
    ];
    const result = ids(applyProjectsView(items, all({ sort })));
    expect(result.slice(2).sort()).toEqual(["arch-new", "arch-old"]);
    const expectFirst = { activity: "live-new", created: "live-new", progress: "live-new", health: "live-new" }[sort];
    expect(result[0]).toBe(expectFirst);
    expect(result[2]).toBe("arch-new");
  });

  it("不改动传入数组", () => {
    const items = [meta("a"), meta("b", { lastEventAt: "2026-10-02T00:00:00.000Z" })];
    applyProjectsView(items, all({}));
    expect(ids(items)).toEqual(["a", "b"]);
  });
});
