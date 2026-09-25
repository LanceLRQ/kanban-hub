import { describe, expect, it } from "vitest";
import { checklistProgress, containerStatus, isStale, parseStaleDays, progressOf, projectProgress, summarizeContainer } from "./derive";
import type { TaskStatus } from "./schema";
import { fixtureId, makeContainer, makeMisc, makeProject, makeTask } from "./test-fixtures";

const tasksOf = (...statuses: TaskStatus[]) => statuses.map((status) => ({ status }));

describe("containerStatus", () => {
  const phase = makeContainer();

  it.each<[string, TaskStatus[], string]>([
    ["没有任务 → 待开始", [], "todo"],
    ["全部待开始 → 待开始", ["todo", "todo"], "todo"],
    ["待开始加已取消 → 待开始", ["todo", "cancelled"], "todo"],
    ["全部已取消 → 待开始", ["cancelled"], "todo"],
    ["全部已完成 → 已完成", ["done", "done"], "done"],
    ["已完成加已取消 → 已完成", ["done", "cancelled"], "done"],
    ["已完成加待开始 → 进行中", ["done", "todo"], "in_progress"],
    ["有复核中 → 进行中", ["review"], "in_progress"],
    ["有挂起 → 进行中", ["todo", "suspended"], "in_progress"],
  ])("%s", (_name, statuses, expected) => {
    expect(containerStatus(phase, tasksOf(...statuses))).toBe(expected);
  });

  it("有手动状态时直接用它", () => {
    expect(containerStatus(makeContainer({ manualStatus: "backlog" }), tasksOf("done"))).toBe("backlog");
  });

  it("杂项容器不参与推算", () => {
    expect(containerStatus(makeMisc(), tasksOf("in_progress"))).toBeNull();
  });
});

describe("summarizeContainer", () => {
  it("开始日期取最早的 startedAt；已完成时，完成日期取最晚的 completedAt", () => {
    const tasks = [
      makeTask({ id: fixtureId("t", 1), status: "done", startedAt: "2026-09-03T00:00:00.000Z", completedAt: "2026-09-05T00:00:00.000Z" }),
      makeTask({ id: fixtureId("t", 2), status: "done", startedAt: "2026-09-02T00:00:00.000Z", completedAt: "2026-09-04T00:00:00.000Z" }),
      makeTask({ id: fixtureId("t", 3), containerId: fixtureId("c", 9), status: "todo" }),
    ];
    expect(summarizeContainer(makeContainer(), tasks)).toEqual({
      status: "done",
      startedAt: "2026-09-02T00:00:00.000Z",
      completedAt: "2026-09-05T00:00:00.000Z",
      progress: { done: 2, total: 2 },
      openCount: 0,
    });
  });

  it("没有全部完成时不给完成日期", () => {
    const tasks = [
      makeTask({ id: fixtureId("t", 1), status: "done", startedAt: "2026-09-02T00:00:00.000Z", completedAt: "2026-09-04T00:00:00.000Z" }),
      makeTask({ id: fixtureId("t", 2), status: "in_progress", startedAt: "2026-09-03T00:00:00.000Z" }),
    ];
    expect(summarizeContainer(makeContainer(), tasks)).toMatchObject({
      status: "in_progress",
      startedAt: "2026-09-02T00:00:00.000Z",
      completedAt: null,
      openCount: 1,
    });
  });

  it("杂项容器只统计未完成数，没有状态和日期", () => {
    const misc = makeMisc();
    const tasks = [
      makeTask({ id: fixtureId("t", 1), containerId: misc.id, status: "in_progress", startedAt: "2026-09-02T00:00:00.000Z" }),
      makeTask({ id: fixtureId("t", 2), containerId: misc.id, status: "done", completedAt: "2026-09-04T00:00:00.000Z" }),
    ];
    expect(summarizeContainer(misc, tasks)).toMatchObject({ status: null, startedAt: null, completedAt: null, openCount: 1 });
  });
});

describe("进度", () => {
  it("不计已取消的任务", () => {
    expect(progressOf(tasksOf("done", "todo", "cancelled"))).toEqual({ done: 1, total: 2 });
  });

  it("清单完成度", () => {
    expect(checklistProgress([{ done: true }, { done: false }])).toEqual({ done: 1, total: 2 });
  });
});

describe("projectProgress", () => {
  it("只统计阶段和特性容器里的任务，不含杂项容器", () => {
    const misc = makeMisc();
    const phase = makeContainer({ id: fixtureId("c", 1) });
    const board = {
      containers: [misc, phase],
      tasks: [
        makeTask({ id: fixtureId("t", 1), containerId: phase.id, status: "done" }),
        makeTask({ id: fixtureId("t", 2), containerId: phase.id, status: "todo" }),
        // 杂项容器里塞已完成和未完成的任务：不应该影响项目进度的分子分母
        makeTask({ id: fixtureId("t", 3), containerId: misc.id, status: "done" }),
        makeTask({ id: fixtureId("t", 4), containerId: misc.id, status: "todo" }),
      ],
    };
    expect(projectProgress(board)).toEqual({ done: 1, total: 2 });
  });

  it("不计已取消的任务（复用 progressOf）", () => {
    const misc = makeMisc();
    const phase = makeContainer({ id: fixtureId("c", 1) });
    const board = {
      containers: [misc, phase],
      tasks: [
        makeTask({ id: fixtureId("t", 1), containerId: phase.id, status: "done" }),
        makeTask({ id: fixtureId("t", 2), containerId: phase.id, status: "cancelled" }),
      ],
    };
    expect(projectProgress(board)).toEqual({ done: 1, total: 1 });
  });
});

describe("isStale", () => {
  const now = new Date("2026-09-23T00:00:00.000Z");

  it("最近一条事件超过 7 天为停滞", () => {
    expect(isStale(makeProject(), "2026-09-15T23:59:59.000Z", now)).toBe(true);
  });

  it("正好 7 天不算停滞", () => {
    expect(isStale(makeProject(), "2026-09-16T00:00:00.000Z", now)).toBe(false);
  });

  it("归档的项目不算停滞", () => {
    expect(isStale(makeProject({ cycle: "archived" }), "2026-01-01T00:00:00.000Z", now)).toBe(false);
  });

  it("没有事件时按项目创建时间算", () => {
    expect(isStale(makeProject({ createdAt: "2026-09-01T00:00:00.000Z" }), null, now)).toBe(true);
  });

  it("可以指定天数", () => {
    expect(isStale(makeProject(), "2026-09-20T00:00:00.000Z", now, 2)).toBe(true);
  });
});

describe("parseStaleDays", () => {
  it.each<[string | undefined, number]>([
    [undefined, 7],
    ["", 7],
    ["abc", 7],
    ["0", 7],
    ["-3", 7],
    ["1.5", 7],
    ["14", 14],
  ])("%s → %s", (raw, expected) => {
    expect(parseStaleDays(raw)).toBe(expected);
  });
});
