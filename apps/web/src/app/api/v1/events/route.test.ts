import { afterEach, describe, expect, it } from "vitest";
import type { Actor, Event } from "@kanban-hub/core/schema";
import { setupTestApi, type TestApi } from "@/server/api/testing";
import { GET } from "./route";

interface EventsBody {
  events: Event[];
  nextCursor: string | null;
}

async function eventsBody(res: Response): Promise<EventsBody> {
  return (await res.json()) as EventsBody;
}

async function machineActor(api: TestApi): Promise<Actor> {
  const { machine } = await api.pairMachine();
  return { userId: machine.userId, machineId: machine.id, via: "cli", agent: null };
}

describe("GET /api/v1/events", () => {
  let api: TestApi;

  afterEach(async () => {
    await api?.cleanup();
  });

  it("同一次修改产生的多条事件时间戳相同，翻页时既不重复也不遗漏，最后一页 nextCursor 为 null", async () => {
    api = await setupTestApi();
    const actor = await machineActor(api);
    const { project, board } = await api.store.createProject({ name: "看板" }, actor);
    const task = await api.store.createTask(project.id, { containerId: board.containers[0]!.id, title: "任务" }, actor);
    // status / human / note 一起变化，一次 mutate 产生 3 条事件，时间戳相同；
    // 加上更早的 project.created、task.created，一共 5 条
    await api.store.updateTask(
      project.id,
      task.id,
      { status: "in_progress", human: { kind: "verify", note: "待确认" }, note: "备注" },
      actor,
    );

    const cookie = api.sessionCookie();
    const firstPage = await eventsBody(
      await GET(api.request(`/api/v1/events?project=${project.id}&limit=3`, { cookie })),
    );
    expect(firstPage.events).toHaveLength(3);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await eventsBody(
      await GET(
        api.request(`/api/v1/events?project=${project.id}&limit=3&before=${encodeURIComponent(firstPage.nextCursor!)}`, {
          cookie,
        }),
      ),
    );
    // project.created + task.created 两条更早的事件
    expect(secondPage.events).toHaveLength(2);
    expect(secondPage.nextCursor).toBeNull();

    const allIds = [...firstPage.events, ...secondPage.events].map((e) => e.id);
    expect(new Set(allIds).size).toBe(5);
  });

  it("不带 project 时查询全部项目，带 project 时只返回该项目的事件", async () => {
    api = await setupTestApi();
    const actor = await machineActor(api);
    const { project: p1 } = await api.store.createProject({ name: "看板一" }, actor);
    const { project: p2 } = await api.store.createProject({ name: "看板二" }, actor);
    const cookie = api.sessionCookie();

    const filtered = await eventsBody(await GET(api.request(`/api/v1/events?project=${p1.id}&limit=10`, { cookie })));
    expect(filtered.events.every((e) => e.projectId === p1.id)).toBe(true);
    expect(filtered.events.length).toBeGreaterThan(0);

    const all = await eventsBody(await GET(api.request("/api/v1/events?limit=10", { cookie })));
    const projectIds = new Set(all.events.map((e) => e.projectId));
    expect(projectIds.has(p1.id)).toBe(true);
    expect(projectIds.has(p2.id)).toBe(true);
  });

  it("机器令牌也能查询（auth: any）", async () => {
    api = await setupTestApi();
    const { token } = await api.pairMachine();
    const res = await GET(api.request("/api/v1/events?limit=10", { token }));
    expect(res.status).toBe(200);
  });

  it("项目不存在返回 404", async () => {
    api = await setupTestApi();
    const cookie = api.sessionCookie();
    const res = await GET(api.request("/api/v1/events?project=does-not-exist", { cookie }));
    expect(res.status).toBe(404);
  });

  it("游标非法返回 400", async () => {
    api = await setupTestApi();
    const cookie = api.sessionCookie();
    const res = await GET(api.request("/api/v1/events?before=not-a-cursor", { cookie }));
    expect(res.status).toBe(400);
  });

  it("limit 越界或不是整数时返回 400", async () => {
    api = await setupTestApi();
    const cookie = api.sessionCookie();
    expect((await GET(api.request("/api/v1/events?limit=0", { cookie }))).status).toBe(400);
    expect((await GET(api.request("/api/v1/events?limit=201", { cookie }))).status).toBe(400);
    expect((await GET(api.request("/api/v1/events?limit=abc", { cookie }))).status).toBe(400);
  });
});
