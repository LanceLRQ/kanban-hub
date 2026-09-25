import { createTranslator } from "next-intl";
import { afterEach, describe, expect, it } from "vitest";
import type { Actor } from "@kanban-hub/core/schema";
import { makeBoard, makeContainer, makeEvent, makeTask } from "@kanban-hub/core/test-fixtures";
import { setupTestApi, type TestApi } from "@/server/api/testing";
import enumsMessages from "../../../messages/zh-CN/enums.json";
import { buildOverview, inboxItemText, resolveLastEvent } from "./overview";

const DAY_MS = 86_400_000;

type LooseTranslator = (key: string, values?: Record<string, string | number>) => string;
const tEnums = createTranslator({ locale: "zh-CN", messages: enumsMessages }) as unknown as LooseTranslator;
function enumLabel(group: string, value: string): string {
  return tEnums(`${group}.${value}`);
}

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

function webActorOf(a: TestApi): Actor {
  const admin = a.store.auth.listUsers().find((u) => u.role === "admin")!;
  return { userId: admin.id, machineId: null, via: "web", agent: null };
}

async function projectWithContainer(a: TestApi, name: string) {
  const actor = webActorOf(a);
  const { project } = await a.store.createProject({ name, cycle: "development", health: "on_track", focus: "" }, actor);
  const container = await a.store.createContainer(project.id, { kind: "phase", title: "阶段一" }, actor);
  return { project, container, actor };
}

describe("inboxItemText", () => {
  it("human.note 非空时用它", () => {
    const task = makeTask({ human: { kind: "decision", note: "拍板" }, title: "标题" });
    expect(inboxItemText(task)).toBe("拍板");
  });

  it("human.note 为空时用任务标题兜底", () => {
    const task = makeTask({ human: { kind: "decision", note: "" }, title: "标题" });
    expect(inboxItemText(task)).toBe("标题");
  });
});

describe("resolveLastEvent", () => {
  it("没有事件（undefined）时为 null", () => {
    const board = makeBoard();
    const ctx = { board, projectName: "示例项目", enumLabel, userName: (id: string) => id, machineName: (id: string) => id };
    expect(resolveLastEvent(undefined, ctx)).toBeNull();
  });

  it("有事件时返回描述、操作者、时间戳", () => {
    const container = makeContainer();
    const board = makeBoard([container]);
    const event = makeEvent({ type: "container.created", target: { containerId: container.id }, ts: "2026-09-01T00:00:00.000Z" });
    const ctx = {
      board,
      projectName: "示例项目",
      enumLabel,
      userName: (id: string) => id,
      machineName: (id: string) => (id === event.actor.machineId ? "mac-mini" : id),
    };
    const result = resolveLastEvent(event, ctx);
    expect(result).not.toBeNull();
    expect(result?.ts).toBe("2026-09-01T00:00:00.000Z");
    expect(result?.description.key).toBe("container.created");
    expect(result?.actor.primary).toBe(event.actor.agent);
    expect(result?.actor.secondary).toBe("mac-mini");
  });
});

describe("buildOverview：收件箱", () => {
  it("只收 human 不为空、状态不是已完成或已取消的任务", async () => {
    api = await setupTestApi();
    const { project, container, actor } = await projectWithContainer(api, "kanban-hub");
    await api.store.createTask(project.id, { containerId: container.id, title: "无 human" }, actor);
    await api.store.createTask(project.id, { containerId: container.id, title: "已完成", human: { kind: "action", note: "x" }, status: "done" }, actor);
    await api.store.createTask(
      project.id,
      { containerId: container.id, title: "已取消", human: { kind: "action", note: "x" }, status: "cancelled" },
      actor,
    );
    const included = await api.store.createTask(
      project.id,
      { containerId: container.id, title: "待处理", human: { kind: "action", note: "处理一下" } },
      actor,
    );

    const view = await buildOverview(api.services, new Date(), enumLabel);
    const allIds = view.inbox.flatMap((g) => g.items.map((i) => i.taskId));
    expect(allIds).toEqual([included.id]);
  });

  it("分组固定按决策、验证、操作排列，空组也保留；组内按 updatedAt 倒序", async () => {
    api = await setupTestApi();
    const { project, container, actor } = await projectWithContainer(api, "kanban-hub");
    const older = await api.store.createTask(project.id, { containerId: container.id, title: "早", human: { kind: "decision", note: "早" } }, actor);
    const newer = await api.store.createTask(project.id, { containerId: container.id, title: "晚", human: { kind: "decision", note: "晚" } }, actor);

    const view = await buildOverview(api.services, new Date(), enumLabel);
    expect(view.inbox.map((g) => g.kind)).toEqual(["decision", "verify", "action"]);
    expect(view.inbox[1]!.items).toEqual([]);
    expect(view.inbox[2]!.items).toEqual([]);
    expect(view.inbox[0]!.items.map((i) => i.taskId)).toEqual([newer.id, older.id]);
  });

  it("text 为空时用任务标题（跨 buildOverview 整体验证一次防御分支）", async () => {
    api = await setupTestApi();
    const { project, container, actor } = await projectWithContainer(api, "kanban-hub");
    const task = await api.store.createTask(project.id, { containerId: container.id, title: "标题兜底", human: { kind: "verify", note: "备注" } }, actor);

    const view = await buildOverview(api.services, new Date(), enumLabel);
    const item = view.inbox.find((g) => g.kind === "verify")!.items.find((i) => i.taskId === task.id)!;
    expect(item.text).toBe("备注");
  });

  it("跨项目汇总", async () => {
    api = await setupTestApi();
    const a = await projectWithContainer(api, "项目 A");
    const b = await projectWithContainer(api, "项目 B");
    await api.store.createTask(a.project.id, { containerId: a.container.id, title: "A 任务", human: { kind: "verify", note: "校验" } }, a.actor);
    await api.store.createTask(b.project.id, { containerId: b.container.id, title: "B 任务", human: { kind: "verify", note: "校验" } }, b.actor);

    const view = await buildOverview(api.services, new Date(), enumLabel);
    const verifyGroup = view.inbox.find((g) => g.kind === "verify")!;
    expect(verifyGroup.items).toHaveLength(2);
    expect(verifyGroup.items.map((i) => i.projectName).sort()).toEqual(["项目 A", "项目 B"]);
  });
});

describe("buildOverview：项目卡片", () => {
  it("进度不计杂项、不计已取消；没有登记位置时 location 为 null", async () => {
    api = await setupTestApi();
    const { project, container, actor } = await projectWithContainer(api, "kanban-hub");
    await api.store.createTask(project.id, { containerId: container.id, title: "完成", status: "done" }, actor);
    await api.store.createTask(project.id, { containerId: container.id, title: "取消", status: "cancelled" }, actor);
    const board = api.store.getBoard(project.id)!;
    const misc = board.containers.find((c) => c.kind === "misc")!;
    await api.store.createTask(project.id, { containerId: misc.id, title: "杂项任务" }, actor);

    const view = await buildOverview(api.services, new Date(), enumLabel);
    const card = view.projects.find((p) => p.id === project.id)!;
    expect(card.progress).toEqual({ done: 1, total: 1 });
    expect(card.location).toBeNull();
  });

  it("最近活动取最新的一条事件", async () => {
    api = await setupTestApi();
    const { project, container, actor } = await projectWithContainer(api, "kanban-hub");
    await api.store.createTask(project.id, { containerId: container.id, title: "任务一" }, actor);
    const task2 = await api.store.createTask(project.id, { containerId: container.id, title: "任务二" }, actor);

    const view = await buildOverview(api.services, new Date(), enumLabel);
    const card = view.projects.find((p) => p.id === project.id)!;
    expect(card.lastEvent).not.toBeNull();
    expect(card.lastEvent?.ts).toBe(task2.updatedAt);
    expect(card.lastEvent?.description.key).toBe("task.created");
  });

  it("停滞：距最近事件超过阈值天数时带上天数；未超过时为 null", async () => {
    api = await setupTestApi();
    const { project } = await projectWithContainer(api, "kanban-hub");

    const fresh = await buildOverview(api.services, new Date(), enumLabel);
    expect(fresh.projects.find((p) => p.id === project.id)?.stale).toBeNull();

    const staleNow = new Date(Date.now() + 10 * DAY_MS);
    const staleView = await buildOverview(api.services, staleNow, enumLabel);
    const card = staleView.projects.find((p) => p.id === project.id)!;
    expect(card.stale).not.toBeNull();
    expect(card.stale?.days).toBeGreaterThanOrEqual(10);
  });

  it("排序：未归档按最近事件时间倒序；归档的放在最后", async () => {
    api = await setupTestApi();
    const actor = webActorOf(api);
    const { project: p1 } = await api.store.createProject({ name: "P1", cycle: "development", health: "on_track", focus: "" }, actor);
    const { project: p2 } = await api.store.createProject({ name: "P2", cycle: "development", health: "on_track", focus: "" }, actor);
    const { project: p3 } = await api.store.createProject({ name: "P3", cycle: "development", health: "on_track", focus: "" }, actor);

    // p3 归档（此时是三者中最新的事件），随后再让 p1 产生一条更新的事件——即便如此，
    // 归档的 p3 也必须排在未归档项目之后
    await api.store.updateProject(p3.id, { cycle: "archived" }, actor);
    await api.store.appendLog(p1.id, { text: "bump" }, actor);

    const view = await buildOverview(api.services, new Date(), enumLabel);
    expect(view.projects.map((p) => p.id)).toEqual([p1.id, p2.id, p3.id]);
  });
});
