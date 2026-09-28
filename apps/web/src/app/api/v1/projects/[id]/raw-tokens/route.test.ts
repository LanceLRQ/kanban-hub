import { afterEach, describe, expect, it } from "vitest";
import type { Actor } from "@kanban-hub/core/schema";
import { setupTestApi, type TestApi } from "@/server/api/testing";
import { POST } from "./route";

const prepActor: Actor = { userId: "0000000000", machineId: null, via: "web", agent: null };

describe("POST /api/v1/projects/:id/raw-tokens", () => {
  let api: TestApi;

  afterEach(async () => {
    await api?.cleanup();
  });

  it("会话鉴权：为已登记位置的机器签一个 /raw 令牌", async () => {
    api = await setupTestApi();
    const { project } = await api.store.createProject({ name: "测试项目" }, prepActor);
    const { machine } = await api.pairMachine("mac");
    await api.store.setLocation(project.id, machine.id, { path: "/repo" }, prepActor);

    const res = await POST(
      api.request(`/api/v1/projects/${project.id}/raw-tokens`, { method: "POST", json: { machineId: machine.id }, cookie: api.sessionCookie() }),
      api.ctx({ id: project.id }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; expiresAt: string };
    expect(typeof body.token).toBe("string");
    expect(typeof body.expiresAt).toBe("string");
  });

  it("机器令牌调用返回 403", async () => {
    api = await setupTestApi();
    const { project } = await api.store.createProject({ name: "测试项目" }, prepActor);
    const { token, machine } = await api.pairMachine("mac");

    const res = await POST(
      api.request(`/api/v1/projects/${project.id}/raw-tokens`, { method: "POST", json: { machineId: machine.id }, token }),
      api.ctx({ id: project.id }),
    );
    expect(res.status).toBe(403);
  });

  it("机器没有登记这个项目的位置时返回 404", async () => {
    api = await setupTestApi();
    const { project } = await api.store.createProject({ name: "测试项目" }, prepActor);
    const { machine } = await api.pairMachine("mac");

    const res = await POST(
      api.request(`/api/v1/projects/${project.id}/raw-tokens`, { method: "POST", json: { machineId: machine.id }, cookie: api.sessionCookie() }),
      api.ctx({ id: project.id }),
    );
    expect(res.status).toBe(404);
  });
});
