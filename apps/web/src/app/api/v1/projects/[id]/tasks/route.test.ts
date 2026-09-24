import { afterEach, describe, expect, it } from "vitest";
import { HEADER_KH_AGENT } from "@kanban-hub/core/api";
import type { Actor, Event } from "@kanban-hub/core/schema";
import { setupTestApi, type TestApi } from "@/server/api/testing";
import { POST } from "./route";

const prepActor: Actor = { userId: "0000000000", machineId: null, via: "web", agent: null };

describe("POST /api/v1/projects/:id/tasks", () => {
  let api: TestApi;

  afterEach(async () => {
    await api?.cleanup();
  });

  it("成功创建任务，返回 201 并记录操作者", async () => {
    api = await setupTestApi();
    const { project } = await api.store.createProject({ name: "测试项目" }, prepActor);
    const container = await api.store.createContainer(project.id, { kind: "feature", title: "阶段一" }, prepActor);
    const { token } = await api.pairMachine();

    const res = await POST(
      api.request(`/api/v1/projects/${project.id}/tasks`, {
        method: "POST",
        json: { containerId: container.id, title: "任务一" },
        token,
        headers: { [HEADER_KH_AGENT]: "claude-code" },
      }),
      api.ctx({ id: project.id }),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { title: string; containerId: string };
    expect(body.title).toBe("任务一");
    expect(body.containerId).toBe(container.id);

    const events = await api.store.listEvents({ projectId: project.id, limit: 10 });
    const created = events.find((e: Event) => e.type === "task.created");
    expect(created?.actor.via).toBe("cli");
    expect(created?.actor.agent).toBe("claude-code");
  });

  it("指向不存在的容器时返回 404", async () => {
    api = await setupTestApi();
    const { project } = await api.store.createProject({ name: "测试项目" }, prepActor);
    const { token } = await api.pairMachine();

    const res = await POST(
      api.request(`/api/v1/projects/${project.id}/tasks`, {
        method: "POST",
        json: { containerId: "0000000000", title: "任务一" },
        token,
      }),
      api.ctx({ id: project.id }),
    );
    expect(res.status).toBe(404);
  });

  it("同一个容器里编号重复时返回 400", async () => {
    api = await setupTestApi();
    const { project } = await api.store.createProject({ name: "测试项目" }, prepActor);
    const container = await api.store.createContainer(project.id, { kind: "feature", title: "阶段一" }, prepActor);
    await api.store.createTask(project.id, { containerId: container.id, title: "任务一", code: "T1" }, prepActor);
    const { token } = await api.pairMachine();

    const res = await POST(
      api.request(`/api/v1/projects/${project.id}/tasks`, {
        method: "POST",
        json: { containerId: container.id, title: "任务二", code: "T1" },
        token,
      }),
      api.ctx({ id: project.id }),
    );
    expect(res.status).toBe(400);
  });
});
