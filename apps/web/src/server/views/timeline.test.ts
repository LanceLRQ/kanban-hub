import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeEventCursor } from "@kanban-hub/core/api";
import type { Actor } from "@kanban-hub/core/schema";
import { dayKey, formatDayHeading, serverTimeZone } from "@/lib/time";
import { setServices, type Services } from "@/server/services";
import { PairingRegistry } from "@/server/auth/pairing";
import { FailureLimiter } from "@/server/auth/rate-limit";
import { LastSeenTracker } from "@/server/auth/authenticate";
import { Store } from "@/server/store/store";
import {
  buildTimelinePage,
  parseTimelineCursor,
  parseTimelineFilters,
  TIMELINE_PAGE_SIZE,
  validateTimelineFilters,
  type TimelineLabels,
} from "./timeline";

/** 简单占位标签：本文件的断言只关心结构（分组、筛选、分页、操作者），不校验翻译文本本身 */
const labels: TimelineLabels = {
  enumLabel: (group, value) => `${group}:${value}`,
  noneLabel: "（无）",
  groupLabel: (group) => `group:${group}`,
  webActorLabel: "网页",
};

let dir: string;
let opened: Store[];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "kh-timeline-"));
  opened = [];
});

afterEach(async () => {
  setServices(undefined);
  for (const store of opened) await store.close();
  await fs.rm(dir, { recursive: true, force: true });
});

/** 时钟：按给定的时间戳列表依次返回，用尽后重复最后一个 */
function clock(times: string[]): () => Date {
  let i = 0;
  return () => new Date(times[Math.min(i++, times.length - 1)]!);
}

/** 每次调用前进 1 秒的时钟，保证事件时间戳互不相同，但都落在同一天里 */
function tickingClock(start: string): () => Date {
  let tick = 0;
  return () => new Date(Date.parse(start) + 1000 * tick++);
}

async function openStore(now: () => Date): Promise<Store> {
  const store = await Store.open({ dataDir: dir, now, commitDebounceMs: 60_000, log: () => {} });
  opened.push(store);
  return store;
}

function makeServices(store: Store, now: () => Date = () => new Date()): Services {
  const services: Services = {
    store,
    pairing: new PairingRegistry({ now }),
    limiter: new FailureLimiter({ now }),
    seen: new LastSeenTracker({ now, log: () => {} }),
    publicUrl: null,
    staleDays: 14,
    now,
    log: () => {},
  };
  setServices(services);
  return services;
}

describe("buildTimelinePage", () => {
  it("三种筛选各自生效，组合生效", async () => {
    const times = [
      "2026-09-24T09:00:00.000Z", // 0 project A 创建
      "2026-09-24T09:01:00.000Z", // 1 project B 创建
      "2026-09-24T09:02:00.000Z", // 2 A 里新建容器（web）
      "2026-09-24T09:03:00.000Z", // 3 A 里新建任务（cli）
      "2026-09-24T09:04:00.000Z", // 4 A 里记日志（web）
      "2026-09-24T09:05:00.000Z", // 5 B 里记日志（cli）
    ];
    const store = await openStore(clock(times));
    const services = makeServices(store);

    const admin = await store.auth.createUser({ name: "Lance", role: "admin", passwordHash: "x" });
    const machine = await store.auth.createMachine({ name: "mac-mini", userId: admin.id, os: "darwin", tokenHash: "a".repeat(64) });
    const web: Actor = { userId: admin.id, machineId: null, via: "web", agent: null };
    const cli: Actor = { userId: admin.id, machineId: machine.id, via: "cli", agent: "claude-code" };

    const { project: projectA } = await store.createProject({ name: "kanban-hub" }, web);
    const { project: projectB } = await store.createProject({ name: "note-flow" }, web);
    await store.createContainer(projectA.id, { kind: "phase", title: "阶段一" }, web);
    await store.createTask(projectA.id, { containerId: (await store.getBoard(projectA.id))!.containers[0]!.id, title: "写文档" }, cli);
    await store.appendLog(projectA.id, { text: "A 的日志" }, web);
    await store.appendLog(projectB.id, { text: "B 的日志" }, cli);

    const now = new Date("2026-09-24T10:00:00.000Z");

    // 按项目筛选：只看 A（project.created、container.created、task.created、log 四条）
    const byProject = await buildTimelinePage(services, { projectId: projectA.id }, undefined, now, labels);
    const idsByProject = byProject.days.flatMap((d) => d.items.map((i) => i.description.key + i.projectId));
    expect(byProject.days.flatMap((d) => d.items).every((i) => i.projectId === projectA.id)).toBe(true);
    expect(byProject.days.flatMap((d) => d.items)).toHaveLength(4);
    void idsByProject;

    // 按类型分组筛选：只看 log（两条，跨项目）
    const byGroup = await buildTimelinePage(services, { group: "log" }, undefined, now, labels);
    const groupItems = byGroup.days.flatMap((d) => d.items);
    expect(groupItems).toHaveLength(2);
    expect(groupItems.every((i) => i.group === "log")).toBe(true);

    // 按操作者筛选：只看网页操作（project.created ×2、container.created、log(A) 共 4 条）
    const byActor = await buildTimelinePage(services, { actor: "web" }, undefined, now, labels);
    const actorItems = byActor.days.flatMap((d) => d.items);
    expect(actorItems).toHaveLength(4);
    expect(actorItems.every((i) => i.actor.secondary === null)).toBe(true);

    // 组合筛选：项目 A + 网页操作 → project.created(A)、container.created、log(A) 共 3 条
    const combined = await buildTimelinePage(services, { projectId: projectA.id, actor: "web" }, undefined, now, labels);
    expect(combined.days.flatMap((d) => d.items)).toHaveLength(3);
  });

  it("按天分组，跨午夜的事件分到两天", async () => {
    // 相隔 24 小时，任何时区下都落在不同的日历日；创建用户/项目额外消耗两个时钟节拍，
    // 只筛 log 分组，排除 project.created 对天数分组的干扰
    const day1 = "2026-09-23T10:00:00.000Z";
    const day2 = "2026-09-24T10:00:00.000Z";
    // 第一个节拍被 Store.open() 内部算 windowStart 消耗掉，第二、三个才轮到 createUser/createProject
    const times = ["2026-09-23T08:00:00.000Z", "2026-09-23T09:00:00.000Z", "2026-09-23T09:01:00.000Z", day1, day2];
    const store = await openStore(clock(times));
    const services = makeServices(store);
    const admin = await store.auth.createUser({ name: "Lance", role: "admin", passwordHash: "x" });
    const web: Actor = { userId: admin.id, machineId: null, via: "web", agent: null };
    const { project } = await store.createProject({ name: "kanban-hub" }, web);
    await store.appendLog(project.id, { text: "第一天" }, web);
    await store.appendLog(project.id, { text: "第二天" }, web);

    const now = new Date(day2);
    const page = await buildTimelinePage(services, { group: "log" }, undefined, now, labels);

    const tz = serverTimeZone();
    expect(page.days).toHaveLength(2);
    expect(page.days[0]!.key).toBe(dayKey(day2, tz));
    expect(page.days[1]!.key).toBe(dayKey(day1, tz));
    expect(page.days[0]!.heading).toBe(formatDayHeading(day2, tz, now));
    expect(page.days[1]!.items[0]!.description.values.text).toBe("第一天");
  });

  it("分页：nextCursor 续取的结果与一次取全的结果一致，不重复、不遗漏", async () => {
    const totalEvents = TIMELINE_PAGE_SIZE + 10;
    const store = await openStore(tickingClock("2026-09-24T00:00:00.000Z"));
    const services = makeServices(store);
    const admin = await store.auth.createUser({ name: "Lance", role: "admin", passwordHash: "x" });
    const web: Actor = { userId: admin.id, machineId: null, via: "web", agent: null };
    const { project } = await store.createProject({ name: "kanban-hub" }, web);
    for (let i = 0; i < totalEvents; i++) {
      await store.appendLog(project.id, { text: `日志 ${i}` }, web);
    }

    const now = new Date("2026-09-25T00:00:00.000Z");
    const page1 = await buildTimelinePage(services, { group: "log" }, undefined, now, labels);
    const page1Items = page1.days.flatMap((d) => d.items);
    expect(page1Items).toHaveLength(TIMELINE_PAGE_SIZE);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await buildTimelinePage(services, { group: "log" }, page1.nextCursor ?? undefined, now, labels);
    const page2Items = page2.days.flatMap((d) => d.items);
    expect(page2.nextCursor).toBeNull();

    const combinedIds = [...page1Items, ...page2Items].map((i) => i.id);
    expect(new Set(combinedIds).size).toBe(totalEvents);
    expect(combinedIds).toHaveLength(totalEvents);

    const all = await store.listEvents({ projectId: project.id, types: ["log"], limit: totalEvents + 1 });
    expect(new Set(all.map((e) => e.id))).toEqual(new Set(combinedIds));
  });

  it("筛选选项：机器列表包括已吊销的", async () => {
    const store = await openStore(() => new Date("2026-09-24T09:00:00.000Z"));
    const services = makeServices(store);
    const admin = await store.auth.createUser({ name: "Lance", role: "admin", passwordHash: "x" });
    const active = await store.auth.createMachine({ name: "mac-mini", userId: admin.id, os: "darwin", tokenHash: "a".repeat(64) });
    const revoked = await store.auth.createMachine({ name: "旧笔记本", userId: admin.id, os: "linux", tokenHash: "b".repeat(64) });
    await store.auth.updateMachine(revoked.id, { revokedAt: new Date().toISOString() });

    const page = await buildTimelinePage(services, {}, undefined, new Date(), labels);
    const actorValues = page.filterOptions.actors.map((a) => a.value);
    expect(actorValues).toContain("web");
    expect(actorValues).toContain(active.id);
    expect(actorValues).toContain(revoked.id);
  });

  it("项目筛选选项：归档的项目排在最后", async () => {
    const store = await openStore(() => new Date("2026-09-24T09:00:00.000Z"));
    const services = makeServices(store);
    const admin = await store.auth.createUser({ name: "Lance", role: "admin", passwordHash: "x" });
    const web: Actor = { userId: admin.id, machineId: null, via: "web", agent: null };
    const { project: active } = await store.createProject({ name: "kanban-hub" }, web);
    const { project: archived } = await store.createProject({ name: "旧项目", cycle: "archived" }, web);

    const page = await buildTimelinePage(services, {}, undefined, new Date(), labels);
    const order = page.filterOptions.projects.map((p) => p.value);
    expect(order.indexOf(active.id)).toBeLessThan(order.indexOf(archived.id));
  });

  it("描述与操作者：网页操作显示用户名，命令行操作显示 agent 名加机器名", async () => {
    const store = await openStore(() => new Date("2026-09-24T09:00:00.000Z"));
    const services = makeServices(store);
    const admin = await store.auth.createUser({ name: "Lance", role: "admin", passwordHash: "x" });
    const machine = await store.auth.createMachine({ name: "mac-mini", userId: admin.id, os: "darwin", tokenHash: "a".repeat(64) });
    const web: Actor = { userId: admin.id, machineId: null, via: "web", agent: null };
    const cli: Actor = { userId: admin.id, machineId: machine.id, via: "cli", agent: "claude-code" };
    const { project } = await store.createProject({ name: "kanban-hub" }, web);
    await store.appendLog(project.id, { text: "网页记的" }, web);
    await store.appendLog(project.id, { text: "命令行记的" }, cli);

    const page = await buildTimelinePage(services, {}, undefined, new Date(), labels);
    const items = page.days.flatMap((d) => d.items);
    const webItem = items.find((i) => i.description.values.text === "网页记的")!;
    const cliItem = items.find((i) => i.description.values.text === "命令行记的")!;
    expect(webItem.actor).toEqual({ primary: "Lance", secondary: null });
    expect(cliItem.actor).toEqual({ primary: "claude-code", secondary: "mac-mini" });
  });
});

/** parseTimelineFilters / validateTimelineFilters / parseTimelineCursor 共用的固定装置：一个项目、一台机器 */
async function setupFixture(): Promise<{ services: Services; store: Store; projectId: string; machineId: string }> {
  const store = await openStore(() => new Date("2026-09-24T09:00:00.000Z"));
  const services = makeServices(store);
  const admin = await store.auth.createUser({ name: "Lance", role: "admin", passwordHash: "x" });
  const machine = await store.auth.createMachine({ name: "mac-mini", userId: admin.id, os: "darwin", tokenHash: "a".repeat(64) });
  const web: Actor = { userId: admin.id, machineId: null, via: "web", agent: null };
  const { project } = await store.createProject({ name: "kanban-hub" }, web);
  return { services, store, projectId: project.id, machineId: machine.id };
}

describe("parseTimelineFilters（URL 查询参数，宽松：不合法就忽略，不报错）", () => {
  it("忽略不合法或不存在的查询参数", async () => {
    const { services } = await setupFixture();
    const filters = parseTimelineFilters(services, { project: "not-a-real-project", type: "not-a-group", actor: "not-a-machine" });
    expect(filters).toEqual({ projectId: undefined, group: undefined, actor: undefined });
  });

  it("接受合法的查询参数", async () => {
    const { services, projectId, machineId } = await setupFixture();
    const filters = parseTimelineFilters(services, { project: projectId, type: "log", actor: machineId });
    expect(filters).toEqual({ projectId, group: "log", actor: machineId });
  });

  it("项目内时间线固定 projectId，忽略查询参数里的 project", async () => {
    const { services, projectId } = await setupFixture();
    const filters = parseTimelineFilters(services, { project: "other" }, { fixedProjectId: projectId });
    expect(filters.projectId).toBe(projectId);
  });
});

describe("validateTimelineFilters（Server Action 入参，严格：提供了就必须合法，否则整体拒绝）", () => {
  it("没有提供任何筛选时返回空的合法结果", async () => {
    const { services } = await setupFixture();
    expect(validateTimelineFilters(services, {})).toEqual({});
    expect(validateTimelineFilters(services, undefined)).toEqual({});
  });

  it("伪造的 group（不是 EVENT_GROUPS 的键）：整体拒绝", async () => {
    const { services } = await setupFixture();
    expect(validateTimelineFilters(services, { group: "not-a-real-group" })).toBeNull();
  });

  it("伪造的 projectId（格式不对，或格式对但项目不存在）：整体拒绝", async () => {
    const { services } = await setupFixture();
    expect(validateTimelineFilters(services, { projectId: "not-an-id" })).toBeNull();
    expect(validateTimelineFilters(services, { projectId: "zzzzzzzzzz" })).toBeNull();
  });

  it("伪造的 actor（既不是 web，也不是存在的机器 ID）：整体拒绝", async () => {
    const { services } = await setupFixture();
    expect(validateTimelineFilters(services, { actor: "not-a-machine" })).toBeNull();
    expect(validateTimelineFilters(services, { actor: "zzzzzzzzzz" })).toBeNull();
  });

  it("raw 本身不是对象（数组、字符串、数字）：整体拒绝，不抛异常", async () => {
    const { services } = await setupFixture();
    expect(validateTimelineFilters(services, "not-an-object")).toBeNull();
    expect(validateTimelineFilters(services, ["group", "log"])).toBeNull();
    expect(validateTimelineFilters(services, 42)).toBeNull();
    expect(validateTimelineFilters(services, null)).toBeNull();
  });

  it("字段类型不对（数字、对象）也当作不合法，不抛异常", async () => {
    const { services } = await setupFixture();
    expect(validateTimelineFilters(services, { group: 123 })).toBeNull();
    expect(validateTimelineFilters(services, { projectId: { evil: true } })).toBeNull();
    expect(validateTimelineFilters(services, { actor: ["web"] })).toBeNull();
  });

  it("合法输入原样通过", async () => {
    const { services, projectId, machineId } = await setupFixture();
    expect(validateTimelineFilters(services, { projectId, group: "log", actor: machineId })).toEqual({
      projectId,
      group: "log",
      actor: machineId,
    });
    expect(validateTimelineFilters(services, { actor: "web" })).toEqual({ actor: "web" });
  });
});

describe("parseTimelineCursor（Server Action 入参：必须是 encodeEventCursor 编码出的字符串）", () => {
  it("合法的编码游标能解析回原值", () => {
    const cursor = { ts: "2026-09-24T09:00:00.000Z", id: "e000000001" };
    expect(parseTimelineCursor(encodeEventCursor(cursor))).toEqual(cursor);
  });

  it("伪造的字符串、错误的类型都返回 null，不抛异常", () => {
    expect(parseTimelineCursor("不是游标")).toBeNull();
    expect(parseTimelineCursor("2026-09-24T09:00:00.000Z_太短")).toBeNull();
    expect(parseTimelineCursor(undefined)).toBeNull();
    expect(parseTimelineCursor(null)).toBeNull();
    expect(parseTimelineCursor({ ts: "2026-09-24T09:00:00.000Z", id: "e000000001" })).toBeNull();
    expect(parseTimelineCursor(42)).toBeNull();
  });
});
