import { describe, expect, it } from "vitest";
import type { ProjectDetailResponse } from "@kanban-hub/core/api";
import { T0, fixtureId, makeBoard, makeContainer, makeProject, makeTask } from "@kanban-hub/core/test-fixtures";
import { buildStatusView } from "./view";
import { renderStatusText, toStatusJson } from "./render";

const MACHINE_ID = fixtureId("m", 1);

function render(overrides: Partial<ProjectDetailResponse> = {}, now: Date = new Date(T0)): string {
  const detail: ProjectDetailResponse = {
    project: makeProject(),
    board: makeBoard(),
    lastEventAt: T0,
    stale: false,
    ...overrides,
  };
  return renderStatusText(buildStatusView(detail, { machineId: MACHINE_ID, now }));
}

describe("renderStatusText", () => {
  it("待开始/进行中的容器展开，逐条列出未完成任务", () => {
    const c = makeContainer({ id: fixtureId("c", 1), code: "M1" });
    const board = makeBoard([c], [makeTask({ id: fixtureId("t", 1), containerId: c.id, title: "任务甲", status: "in_progress" })]);
    const text = render({ board });
    expect(text).toContain("任务甲");
  });

  it("已完成/已取消/储备/挂起的容器折叠成一行摘要，不逐条列出任务", () => {
    const c = makeContainer({ id: fixtureId("c", 1), code: "M1", manualStatus: "backlog" });
    const board = makeBoard([c], [makeTask({ id: fixtureId("t", 1), containerId: c.id, title: "任务甲" })]);
    const text = render({ board });
    expect(text).not.toContain("任务甲");
    expect(text).toContain("储备");
  });

  it("已完成容器折叠时带完成日期，只显示日期部分（不带时分秒）", () => {
    const c = makeContainer({ id: fixtureId("c", 1), code: "M1" });
    const board = makeBoard([c], [makeTask({ id: fixtureId("t", 1), containerId: c.id, status: "done", completedAt: "2026-09-10T08:30:00.000Z" })]);
    const text = render({ board });
    expect(text).toContain("已完成");
    expect(text).toContain("2026-09-10");
    expect(text).not.toContain("08:30:00");
    expect(text).not.toContain("T08:30");
  });

  it("折叠容器的任务数不计已取消的；有已取消任务时另注一句", () => {
    const c = makeContainer({ id: fixtureId("c", 1), code: "M1", manualStatus: "backlog" });
    const board = makeBoard(
      [c],
      [
        makeTask({ id: fixtureId("t", 1), containerId: c.id, title: "存活任务" }),
        makeTask({ id: fixtureId("t", 2), containerId: c.id, title: "取消的任务", status: "cancelled" }),
      ],
    );
    const text = render({ board });
    const line = text.split("\n").find((l) => l.includes("储备"));
    expect(line).toBeDefined();
    expect(line).toContain("共 1 个任务");
    expect(line).toContain("另有 1 个已取消");
    expect(text).not.toContain("存活任务");
    expect(text).not.toContain("取消的任务");
  });

  it("折叠容器没有已取消任务时不出现“另有”提示", () => {
    const c = makeContainer({ id: fixtureId("c", 1), code: "M1", manualStatus: "backlog" });
    const board = makeBoard([c], [makeTask({ id: fixtureId("t", 1), containerId: c.id })]);
    const text = render({ board });
    expect(text).not.toContain("另有");
  });

  it("挂起容器折叠时带原因", () => {
    const c = makeContainer({ id: fixtureId("c", 1), code: "M1", manualStatus: "suspended", manualReason: "等外部依赖" });
    const board = makeBoard([c], []);
    const text = render({ board });
    expect(text).toContain("挂起");
    expect(text).toContain("等外部依赖");
  });

  it("杂项容器固定放在最后展开", () => {
    const c = makeContainer({ id: fixtureId("c", 1), code: "M1" });
    const board = makeBoard([c], [makeTask({ id: fixtureId("t", 1), containerId: fixtureId("c", 0), title: "杂项任务", status: "todo" })]);
    const text = render({ board });
    const miscIndex = text.indexOf("杂项");
    const m1Index = text.indexOf("阶段一");
    expect(m1Index).toBeGreaterThanOrEqual(0);
    expect(miscIndex).toBeGreaterThan(m1Index);
    expect(text).toContain("杂项任务");
  });

  it("杂项容器表头显示未完成任务数量，不显示完成度分数（规格 5.4：杂项不参与推算）", () => {
    const board = makeBoard(
      [makeContainer()],
      [
        makeTask({ id: fixtureId("t", 1), containerId: fixtureId("c", 0), status: "todo" }),
        makeTask({ id: fixtureId("t", 2), containerId: fixtureId("c", 0), status: "done" }),
        makeTask({ id: fixtureId("t", 3), containerId: fixtureId("c", 0), status: "cancelled" }),
      ],
    );
    const text = render({ board });
    const miscLine = text.split("\n").find((l) => l.includes("杂项"));
    expect(miscLine).toBeDefined();
    expect(miscLine).toContain("1 个未完成");
    expect(miscLine).not.toMatch(/\d+\/\d+/);
  });

  it("杂项容器没有未完成任务时显示 0 个未完成", () => {
    const board = makeBoard([makeContainer()], [makeTask({ id: fixtureId("t", 1), containerId: fixtureId("c", 0), status: "done" })]);
    const text = render({ board });
    const miscLine = text.split("\n").find((l) => l.includes("杂项"));
    expect(miscLine).toContain("0 个未完成");
  });

  it("有编号的任务显示为 容器编号/任务编号", () => {
    const c = makeContainer({ id: fixtureId("c", 1), code: "M2" });
    const board = makeBoard([c], [makeTask({ id: fixtureId("t", 1), containerId: c.id, code: "2.3", status: "todo" })]);
    const text = render({ board });
    expect(text).toContain("M2/2.3");
  });

  it("容器没有编号时任务编号前缀用容器的 ID 前缀，写出来的编号仍能直接引用", () => {
    const c = makeContainer({ id: fixtureId("c", 1), code: null });
    const board = makeBoard([c], [makeTask({ id: fixtureId("t", 1), containerId: c.id, code: "2.3", status: "todo" })]);
    const text = render({ board });
    expect(text).toContain(`${c.id}/2.3`);
  });

  it("杂项容器里有编号的任务，编号前缀固定是 misc", () => {
    const board = makeBoard(
      [makeContainer()],
      [makeTask({ id: fixtureId("t", 1), containerId: fixtureId("c", 0), code: "9.9", status: "todo" })],
    );
    const text = render({ board });
    expect(text).toContain("misc/9.9");
  });

  it("待你处理放在最前面（容器信息之前）", () => {
    const c = makeContainer({ id: fixtureId("c", 1), code: "M1" });
    const task = makeTask({
      id: fixtureId("t", 1),
      containerId: c.id,
      status: "in_progress",
      human: { kind: "verify", note: "请验证结果" },
    });
    const board = makeBoard([c], [task]);
    const text = render({ board });
    const inboxIndex = text.indexOf("待你处理");
    const containerIndex = text.indexOf("阶段一");
    expect(inboxIndex).toBeGreaterThanOrEqual(0);
    expect(inboxIndex).toBeLessThan(containerIndex);
  });

  it("停滞时多一行“停滞 N 天”", () => {
    const text = render({ stale: true, lastEventAt: "2026-08-20T00:00:00.000Z" }, new Date("2026-09-01T00:00:00.000Z"));
    expect(text).toMatch(/停滞 \d+ 天/);
  });

  it("不停滞时没有停滞行", () => {
    const text = render({ stale: false });
    expect(text).not.toContain("停滞");
  });

  it("本机有登记位置时文本里出现路径", () => {
    const project = makeProject({
      locations: [{ machineId: MACHINE_ID, path: "/repo/path", lastSyncAt: null, sync: null, git: null, skippedFiles: [] }],
    });
    const text = render({ project });
    expect(text).toContain("/repo/path");
  });

  it("本机没有登记位置时文本里不出现位置相关内容", () => {
    const text = render({});
    expect(text).not.toContain("/repo/path");
  });

  it("已取消的任务不出现在文本里，只计入数量", () => {
    const c = makeContainer({ id: fixtureId("c", 1), code: "M1" });
    const board = makeBoard(
      [c],
      [
        makeTask({ id: fixtureId("t", 1), containerId: c.id, title: "存活任务", status: "todo" }),
        makeTask({ id: fixtureId("t", 2), containerId: c.id, title: "取消的任务", status: "cancelled" }),
      ],
    );
    const text = render({ board });
    expect(text).toContain("存活任务");
    expect(text).not.toContain("取消的任务");
    expect(text).toContain("已取消 1 个");
  });

  it("已完成的任务在展开的容器里不逐条列出，只计入数量", () => {
    const c = makeContainer({ id: fixtureId("c", 1), code: "M1" });
    const board = makeBoard(
      [c],
      [
        makeTask({ id: fixtureId("t", 1), containerId: c.id, title: "进行中任务", status: "in_progress" }),
        makeTask({ id: fixtureId("t", 2), containerId: c.id, title: "已完成任务", status: "done", completedAt: T0 }),
      ],
    );
    const text = render({ board });
    expect(text).toContain("进行中任务");
    expect(text).not.toContain("已完成任务");
    expect(text).toContain("已完成 1 个");
  });

  it("项目行包含名称、周期、健康度与进度；第二行是焦点", () => {
    const project = makeProject({ name: "示例项目", cycle: "development", health: "at_risk", focus: "打磨发布前的细节" });
    const text = render({ project });
    const lines = text.split("\n");
    expect(lines[0]).toContain("示例项目");
    expect(lines[0]).toContain("开发期");
    expect(lines[0]).toContain("有风险");
    expect(lines[1]).toContain("打磨发布前的细节");
  });
});

describe("toStatusJson", () => {
  it("包含全部任务，即使容器在文本里会被折叠", () => {
    const c = makeContainer({ id: fixtureId("c", 1), code: "M1", manualStatus: "backlog" });
    const board = makeBoard([c], [makeTask({ id: fixtureId("t", 1), containerId: c.id, title: "任务甲" })]);
    const detail: ProjectDetailResponse = { project: makeProject(), board, lastEventAt: T0, stale: false };
    const view = buildStatusView(detail, { machineId: MACHINE_ID, now: new Date(T0) });
    const json = toStatusJson(view) as { containers: { tasks: { title: string }[] }[] };
    const titles = json.containers.flatMap((container) => container.tasks.map((t) => t.title));
    expect(titles).toContain("任务甲");
  });

  it("字段名与 StatusView 一致（project/location/containers/inbox）", () => {
    const detail: ProjectDetailResponse = { project: makeProject(), board: makeBoard(), lastEventAt: T0, stale: false };
    const view = buildStatusView(detail, { machineId: MACHINE_ID, now: new Date(T0) });
    const json = toStatusJson(view) as Record<string, unknown>;
    expect(Object.keys(json).sort()).toEqual(["containers", "inbox", "location", "project"]);
  });
});
