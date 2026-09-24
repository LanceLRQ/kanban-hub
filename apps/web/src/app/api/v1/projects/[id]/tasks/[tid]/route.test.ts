import { afterEach, describe, expect, it } from "vitest";
import type { Actor, Event } from "@kanban-hub/core/schema";
import { setupTestApi, type TestApi } from "@/server/api/testing";
import { PATCH } from "./route";

const prepActor: Actor = { userId: "0000000000", machineId: null, via: "web", agent: null };

describe("PATCH /api/v1/projects/:id/tasks/:tid", () => {
  let api: TestApi;

  afterEach(async () => {
    await api?.cleanup();
  });

  it("修改状态为进行中，产生 task.status_changed 事件并写入 startedAt，记录操作者", async () => {
    api = await setupTestApi();
    const { project } = await api.store.createProject({ name: "测试项目" }, prepActor);
    const container = await api.store.createContainer(project.id, { kind: "feature", title: "阶段一" }, prepActor);
    const task = await api.store.createTask(project.id, { containerId: container.id, title: "任务一" }, prepActor);

    const res = await PATCH(
      api.request(`/api/v1/projects/${project.id}/tasks/${task.id}`, {
        method: "PATCH",
        json: { status: "in_progress" },
        cookie: api.sessionCookie(),
      }),
      api.ctx({ id: project.id, tid: task.id }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; startedAt: string | null };
    expect(body.status).toBe("in_progress");
    expect(body.startedAt).not.toBeNull();

    const events = await api.store.listEvents({ projectId: project.id, limit: 10 });
    const changed = events.find((e: Event) => e.type === "task.status_changed");
    expect(changed).toBeDefined();
    expect(changed?.actor.via).toBe("web");
  });

  it("修改状态为已完成，写入 completedAt", async () => {
    api = await setupTestApi();
    const { project } = await api.store.createProject({ name: "测试项目" }, prepActor);
    const container = await api.store.createContainer(project.id, { kind: "feature", title: "阶段一" }, prepActor);
    const task = await api.store.createTask(project.id, { containerId: container.id, title: "任务一" }, prepActor);

    const res = await PATCH(
      api.request(`/api/v1/projects/${project.id}/tasks/${task.id}`, {
        method: "PATCH",
        json: { status: "done" },
        cookie: api.sessionCookie(),
      }),
      api.ctx({ id: project.id, tid: task.id }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; completedAt: string | null };
    expect(body.status).toBe("done");
    expect(body.completedAt).not.toBeNull();
  });

  it("修改待你处理，产生 task.human_changed 事件", async () => {
    api = await setupTestApi();
    const { project } = await api.store.createProject({ name: "测试项目" }, prepActor);
    const container = await api.store.createContainer(project.id, { kind: "feature", title: "阶段一" }, prepActor);
    const task = await api.store.createTask(project.id, { containerId: container.id, title: "任务一" }, prepActor);

    const res = await PATCH(
      api.request(`/api/v1/projects/${project.id}/tasks/${task.id}`, {
        method: "PATCH",
        json: { human: { kind: "decision", note: "需要确认方案" } },
        cookie: api.sessionCookie(),
      }),
      api.ctx({ id: project.id, tid: task.id }),
    );

    expect(res.status).toBe(200);
    const events = await api.store.listEvents({ projectId: project.id, limit: 10 });
    const changed = events.find((e: Event) => e.type === "task.human_changed");
    expect(changed).toBeDefined();
  });

  it("任务不存在时返回 404", async () => {
    api = await setupTestApi();
    const { project } = await api.store.createProject({ name: "测试项目" }, prepActor);

    const res = await PATCH(
      api.request(`/api/v1/projects/${project.id}/tasks/0000000000`, {
        method: "PATCH",
        json: { title: "新标题" },
        cookie: api.sessionCookie(),
      }),
      api.ctx({ id: project.id, tid: "0000000000" }),
    );
    expect(res.status).toBe(404);
  });
});
