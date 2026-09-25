import { describe, expect, it } from "vitest";
import type { ProjectDetailResponse } from "@kanban-hub/core/api";
import { T0, fixtureId, makeBoard, makeContainer, makeProject, makeTask } from "@kanban-hub/core/test-fixtures";
import { buildStatusView } from "./view";

const MACHINE_ID = fixtureId("m", 1);

function detailFrom(overrides: Partial<ProjectDetailResponse> = {}): ProjectDetailResponse {
  return {
    project: makeProject(),
    board: makeBoard(),
    lastEventAt: T0,
    stale: false,
    ...overrides,
  };
}

describe("buildStatusView", () => {
  it("项目字段透传，进度按 progressOf 计算（已取消的任务不计入总数）", () => {
    const board = makeBoard(
      [makeContainer()],
      [
        makeTask({ id: fixtureId("t", 1), status: "done" }),
        makeTask({ id: fixtureId("t", 2), status: "todo" }),
        makeTask({ id: fixtureId("t", 3), status: "cancelled" }),
      ],
    );
    const detail = detailFrom({ board });
    const view = buildStatusView(detail, { machineId: MACHINE_ID, now: new Date(T0) });
    expect(view.project.progress).toEqual({ done: 1, total: 2 });
    expect(view.project.name).toBe(detail.project.name);
    expect(view.project.id).toBe(detail.project.id);
    expect(view.project.cycle).toBe(detail.project.cycle);
    expect(view.project.health).toBe(detail.project.health);
  });

  it("停滞标记透传；idleDays 按 lastEventAt 与 now 的整天差（向下取整）计算", () => {
    const detail = detailFrom({ stale: true, lastEventAt: "2026-09-01T00:00:00.000Z" });
    const now = new Date("2026-09-10T12:00:00.000Z");
    const view = buildStatusView(detail, { machineId: MACHINE_ID, now });
    expect(view.project.stale).toBe(true);
    expect(view.project.idleDays).toBe(9);
  });

  it("lastEventAt 为空时用项目创建时间兜底计算 idleDays", () => {
    const project = makeProject({ createdAt: "2026-09-01T00:00:00.000Z" });
    const detail = detailFrom({ project, lastEventAt: null, stale: true });
    const now = new Date("2026-09-05T00:00:00.000Z");
    const view = buildStatusView(detail, { machineId: MACHINE_ID, now });
    expect(view.project.idleDays).toBe(4);
    expect(view.project.lastEventAt).toBeNull();
  });

  it("本机有登记位置时返回 path/lastSyncAt", () => {
    const project = makeProject({
      locations: [{ machineId: MACHINE_ID, path: "/repo", lastSyncAt: T0, sync: null, git: null, skippedFiles: [] }],
    });
    const detail = detailFrom({ project });
    const view = buildStatusView(detail, { machineId: MACHINE_ID, now: new Date(T0) });
    expect(view.location).toEqual({ path: "/repo", lastSyncAt: T0 });
  });

  it("本机没有登记位置时为 null", () => {
    const detail = detailFrom();
    const view = buildStatusView(detail, { machineId: MACHINE_ID, now: new Date(T0) });
    expect(view.location).toBeNull();
  });

  it("其他机器登记的位置不会被当成本机位置", () => {
    const project = makeProject({
      locations: [{ machineId: fixtureId("m", 2), path: "/other", lastSyncAt: null, sync: null, git: null, skippedFiles: [] }],
    });
    const detail = detailFrom({ project });
    const view = buildStatusView(detail, { machineId: MACHINE_ID, now: new Date(T0) });
    expect(view.location).toBeNull();
  });

  it("容器按 order 排序，杂项固定放在最后（不管它的 order）", () => {
    const c1 = makeContainer({ id: fixtureId("c", 1), order: 2, code: "M2" });
    const c2 = makeContainer({ id: fixtureId("c", 2), order: 1, code: "M1" });
    const board = makeBoard([c1, c2], []);
    const detail = detailFrom({ board });
    const view = buildStatusView(detail, { machineId: MACHINE_ID, now: new Date(T0) });
    expect(view.containers.map((c) => c.code)).toEqual(["M1", "M2", null]);
  });

  it("容器状态用 core 的 summarizeContainer 推算，doneAt 来自 completedAt", () => {
    const container = makeContainer({ id: fixtureId("c", 1) });
    const board = makeBoard(
      [container],
      [makeTask({ id: fixtureId("t", 1), containerId: container.id, status: "done", completedAt: "2026-09-05T00:00:00.000Z" })],
    );
    const detail = detailFrom({ board });
    const view = buildStatusView(detail, { machineId: MACHINE_ID, now: new Date(T0) });
    const found = view.containers.find((c) => c.id === container.id);
    expect(found?.status).toBe("done");
    expect(found?.doneAt).toBe("2026-09-05T00:00:00.000Z");
    expect(found?.progress).toEqual({ done: 1, total: 1 });
  });

  it("容器 openCount 来自 summarizeContainer 的 openCount（既非已完成也非已取消）", () => {
    const container = makeContainer({ id: fixtureId("c", 1) });
    const board = makeBoard(
      [container],
      [
        makeTask({ id: fixtureId("t", 1), containerId: container.id, status: "todo" }),
        makeTask({ id: fixtureId("t", 2), containerId: container.id, status: "in_progress" }),
        makeTask({ id: fixtureId("t", 3), containerId: container.id, status: "done" }),
        makeTask({ id: fixtureId("t", 4), containerId: container.id, status: "cancelled" }),
      ],
    );
    const detail = detailFrom({ board });
    const view = buildStatusView(detail, { machineId: MACHINE_ID, now: new Date(T0) });
    const found = view.containers.find((c) => c.id === container.id);
    expect(found?.openCount).toBe(2);
  });

  it("杂项容器的 openCount 也来自 summarizeContainer，且 status 为 null", () => {
    const board = makeBoard(
      [makeContainer()],
      [
        makeTask({ id: fixtureId("t", 1), containerId: fixtureId("c", 0), status: "todo" }),
        makeTask({ id: fixtureId("t", 2), containerId: fixtureId("c", 0), status: "done" }),
      ],
    );
    const detail = detailFrom({ board });
    const view = buildStatusView(detail, { machineId: MACHINE_ID, now: new Date(T0) });
    const misc = view.containers.find((c) => c.kind === "misc");
    expect(misc?.status).toBeNull();
    expect(misc?.openCount).toBe(1);
  });

  it("项目整体进度不计杂项容器里的任务（Ruling 11）", () => {
    const c1 = makeContainer({ id: fixtureId("c", 1) });
    const board = makeBoard(
      [c1],
      [
        makeTask({ id: fixtureId("t", 1), containerId: c1.id, status: "done" }),
        makeTask({ id: fixtureId("t", 2), containerId: c1.id, status: "todo" }),
        // 杂项容器里塞已完成和未完成的任务：不应该影响项目进度的分子分母
        makeTask({ id: fixtureId("t", 3), containerId: fixtureId("c", 0), status: "done" }),
        makeTask({ id: fixtureId("t", 4), containerId: fixtureId("c", 0), status: "todo" }),
      ],
    );
    const detail = detailFrom({ board });
    const view = buildStatusView(detail, { machineId: MACHINE_ID, now: new Date(T0) });
    expect(view.project.progress).toEqual({ done: 1, total: 2 });
  });

  it("任务 ref 是整个看板范围内的最短唯一前缀", () => {
    const container = makeContainer({ id: fixtureId("c", 1) });
    const board = makeBoard(
      [container],
      [makeTask({ id: "aaaaaaaaaa", containerId: container.id }), makeTask({ id: "aaaabbbbbb", containerId: container.id })],
    );
    const detail = detailFrom({ board });
    const view = buildStatusView(detail, { machineId: MACHINE_ID, now: new Date(T0) });
    const refs = view.containers
      .flatMap((c) => c.tasks)
      .map((t) => t.ref)
      .sort();
    expect(refs).toEqual(["#aaaaa", "#aaaab"]);
  });

  it("任务字段透传：code、group、checklist 完成度等", () => {
    const container = makeContainer({ id: fixtureId("c", 1), code: "M2" });
    const task = makeTask({
      id: fixtureId("t", 1),
      containerId: container.id,
      code: "2.3",
      group: "M2",
      checklist: [
        { text: "一", done: true },
        { text: "二", done: false },
      ],
    });
    const board = makeBoard([container], [task]);
    const detail = detailFrom({ board });
    const view = buildStatusView(detail, { machineId: MACHINE_ID, now: new Date(T0) });
    const found = view.containers[0]!.tasks[0]!;
    expect(found.code).toBe("2.3");
    expect(found.group).toBe("M2");
    expect(found.checklist).toEqual({ done: 1, total: 2 });
  });

  it("收集所有带待你处理标记的任务到 inbox，附带所属容器标签", () => {
    const container = makeContainer({ id: fixtureId("c", 1), code: "M1" });
    const task = makeTask({
      id: fixtureId("t", 1),
      containerId: container.id,
      title: "要不要发布",
      human: { kind: "decision", note: "确认发布窗口" },
    });
    const board = makeBoard([container], [task]);
    const detail = detailFrom({ board });
    const view = buildStatusView(detail, { machineId: MACHINE_ID, now: new Date(T0) });
    expect(view.inbox).toHaveLength(1);
    expect(view.inbox[0]).toMatchObject({
      kind: "decision",
      note: "确认发布窗口",
      taskTitle: "要不要发布",
      container: "M1",
    });
  });

  it("没有待你处理标记的任务不进 inbox", () => {
    const container = makeContainer({ id: fixtureId("c", 1) });
    const board = makeBoard([container], [makeTask({ id: fixtureId("t", 1), containerId: container.id, human: null })]);
    const detail = detailFrom({ board });
    const view = buildStatusView(detail, { machineId: MACHINE_ID, now: new Date(T0) });
    expect(view.inbox).toEqual([]);
  });
});
