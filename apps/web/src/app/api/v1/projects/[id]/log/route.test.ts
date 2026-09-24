import { afterEach, describe, expect, it } from "vitest";
import { HEADER_KH_AGENT } from "@kanban-hub/core/api";
import type { Actor } from "@kanban-hub/core/schema";
import { setupTestApi, type TestApi } from "@/server/api/testing";
import { POST } from "./route";

const prepActor: Actor = { userId: "0000000000", machineId: null, via: "web", agent: null };

describe("POST /api/v1/projects/:id/log", () => {
  let api: TestApi;

  afterEach(async () => {
    await api?.cleanup();
  });

  it("可以带 taskId，返回 201 并记录操作者", async () => {
    api = await setupTestApi();
    const { project } = await api.store.createProject({ name: "测试项目" }, prepActor);
    const container = await api.store.createContainer(project.id, { kind: "feature", title: "阶段一" }, prepActor);
    const task = await api.store.createTask(project.id, { containerId: container.id, title: "任务一" }, prepActor);
    const { token } = await api.pairMachine();

    const res = await POST(
      api.request(`/api/v1/projects/${project.id}/log`, {
        method: "POST",
        json: { text: "完成了初步调研", taskId: task.id },
        token,
        headers: { [HEADER_KH_AGENT]: "claude-code" },
      }),
      api.ctx({ id: project.id }),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { text: string; target: { taskId?: string } | null; actor: Actor };
    expect(body.text).toBe("完成了初步调研");
    expect(body.target?.taskId).toBe(task.id);
    expect(body.actor.via).toBe("cli");
    expect(body.actor.agent).toBe("claude-code");
  });

  it("正文为空时返回 400", async () => {
    api = await setupTestApi();
    const { project } = await api.store.createProject({ name: "测试项目" }, prepActor);
    const { token } = await api.pairMachine();

    const res = await POST(
      api.request(`/api/v1/projects/${project.id}/log`, {
        method: "POST",
        json: { text: "" },
        token,
      }),
      api.ctx({ id: project.id }),
    );
    expect(res.status).toBe(400);
  });

  it("任务不存在时返回 404", async () => {
    api = await setupTestApi();
    const { project } = await api.store.createProject({ name: "测试项目" }, prepActor);
    const { token } = await api.pairMachine();

    const res = await POST(
      api.request(`/api/v1/projects/${project.id}/log`, {
        method: "POST",
        json: { text: "日志", taskId: "0000000000" },
        token,
      }),
      api.ctx({ id: project.id }),
    );
    expect(res.status).toBe(404);
  });
});
