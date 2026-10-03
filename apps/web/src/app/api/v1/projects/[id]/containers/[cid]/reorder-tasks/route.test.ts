import { afterEach, describe, expect, it } from "vitest";
import type { Actor, Event, Task } from "@kanban-hub/core/schema";
import { setupTestApi, type TestApi } from "@/server/api/testing";
import { POST } from "./route";

const actor: Actor = { userId: "0000000000", machineId: null, via: "web", agent: null };

async function seed(api: TestApi) {
  const { project } = await api.store.createProject({ name: "测试项目" }, actor);
  const container = await api.store.createContainer(project.id, { kind: "feature", title: "阶段一" }, actor);
  const tasks: Task[] = [];
  for (const title of ["甲", "乙", "丙"]) {
    tasks.push(await api.store.createTask(project.id, { containerId: container.id, title }, actor));
  }
  return { project, container, tasks };
}

function call(api: TestApi, projectId: string, cid: string, body: unknown, withCookie = true) {
  return POST(
    api.request(`/api/v1/projects/${projectId}/containers/${cid}/reorder-tasks`, {
      method: "POST",
      json: body,
      cookie: withCookie ? api.sessionCookie() : undefined,
    }),
    api.ctx({ id: projectId, cid }),
  );
}

describe("POST /api/v1/projects/:id/containers/:cid/reorder-tasks", () => {
  let api: TestApi;

  afterEach(async () => {
    await api?.cleanup();
  });

  it("重排后返回新顺序，看板顺序一致，事件正好新增一条，updatedAt 不变、version 递增", async () => {
    api = await setupTestApi();
    const { project, container, tasks } = await seed(api);
    const before = await api.store.listEvents({ projectId: project.id, limit: 100 });

    const res = await call(api, project.id, container.id, { taskIds: [tasks[2]!.id, tasks[0]!.id] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Task[];
    expect(body.map((t) => t.id)).toEqual([tasks[2]!.id, tasks[0]!.id, tasks[1]!.id]);

    const board = api.store.getBoard(project.id)!;
    const inBoard = board.tasks.filter((t) => t.containerId === container.id).sort((a, b) => a.order - b.order);
    expect(inBoard.map((t) => t.id)).toEqual(body.map((t) => t.id));
    const moved = inBoard.find((t) => t.id === tasks[2]!.id)!;
    expect(moved.updatedAt).toBe(tasks[2]!.updatedAt);
    expect(moved.version).toBe(tasks[2]!.version + 1);

    const after = await api.store.listEvents({ projectId: project.id, limit: 100 });
    expect(after.length).toBe(before.length + 1);
    expect(after.filter((e: Event) => e.type === "board.reordered")).toHaveLength(1);
  });

  it("顺序不变时返回 200 和当前顺序，不追加事件", async () => {
    api = await setupTestApi();
    const { project, container, tasks } = await seed(api);
    const before = await api.store.listEvents({ projectId: project.id, limit: 100 });
    const res = await call(api, project.id, container.id, { taskIds: [tasks[0]!.id] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Task[]).map((t) => t.id)).toEqual(tasks.map((t) => t.id));
    const after = await api.store.listEvents({ projectId: project.id, limit: 100 });
    expect(after.length).toBe(before.length);
  });

  it("参数不合法返回 400（重复 ID、未知字段）", async () => {
    api = await setupTestApi();
    const { project, container, tasks } = await seed(api);
    const dup = await call(api, project.id, container.id, { taskIds: [tasks[0]!.id, tasks[0]!.id] });
    expect(dup.status).toBe(400);
    expect((await call(api, project.id, container.id, { taskIds: [] })).status).toBe(400);
    const extra = await call(api, project.id, container.id, { taskIds: [], foo: 1 });
    expect(extra.status).toBe(400);
  });

  it("未登录返回 401", async () => {
    api = await setupTestApi();
    const { project, container } = await seed(api);
    const res = await call(api, project.id, container.id, { taskIds: [] }, false);
    expect(res.status).toBe(401);
  });

  it("项目、容器或任务不存在返回 404", async () => {
    api = await setupTestApi();
    const { project, container, tasks } = await seed(api);
    expect((await call(api, "zzzzzzzzzz", container.id, { taskIds: [tasks[0]!.id] })).status).toBe(404);
    expect((await call(api, project.id, "zzzzzzzzzz", { taskIds: [tasks[0]!.id] })).status).toBe(404);
    expect((await call(api, project.id, container.id, { taskIds: ["zzzzzzzzzz"] })).status).toBe(404);
  });
});
