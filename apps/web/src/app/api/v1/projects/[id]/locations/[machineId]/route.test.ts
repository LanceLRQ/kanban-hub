import { afterEach, describe, expect, it } from "vitest";
import { HEADER_KH_AGENT } from "@kanban-hub/core/api";
import type { Actor, Project } from "@kanban-hub/core/schema";
import { setupTestApi, type TestApi } from "@/server/api/testing";
import { PUT } from "./route";

interface ErrorBody {
  error: { code: string; message: string };
}

async function errorOf(res: Response): Promise<ErrorBody["error"]> {
  return ((await res.json()) as ErrorBody).error;
}

async function createProject(api: TestApi): Promise<{ project: Project; actor: Actor }> {
  const { machine } = await api.pairMachine();
  const actor: Actor = { userId: machine.userId, machineId: machine.id, via: "cli", agent: null };
  const { project } = await api.store.createProject({ name: "看板" }, actor);
  return { project, actor };
}

describe("PUT /api/v1/projects/:id/locations/:machineId", () => {
  let api: TestApi;

  afterEach(async () => {
    await api?.cleanup();
  });

  it("新登记会产生事件，重复登记同样的内容不产生新事件", async () => {
    api = await setupTestApi();
    const { project } = await createProject(api);
    const { token, machine } = await api.pairMachine();

    const first = await PUT(
      api.request(`/api/v1/projects/${project.id}/locations/${machine.id}`, { method: "PUT", token, json: { path: "/repo" } }),
      api.ctx({ id: project.id, machineId: machine.id }),
    );
    expect(first.status).toBe(200);
    const afterFirst = await api.store.listEvents({ projectId: project.id, limit: 100 });

    const second = await PUT(
      api.request(`/api/v1/projects/${project.id}/locations/${machine.id}`, { method: "PUT", token, json: { path: "/repo" } }),
      api.ctx({ id: project.id, machineId: machine.id }),
    );
    expect(second.status).toBe(200);
    const afterSecond = await api.store.listEvents({ projectId: project.id, limit: 100 });

    expect(afterSecond).toHaveLength(afterFirst.length);

    const updated = (await second.json()) as Project;
    expect(updated.locations).toEqual([{ machineId: machine.id, path: "/repo", lastSyncAt: null, sync: null, git: null, skippedFiles: [] }]);
  });

  it("给别的机器登记返回 403", async () => {
    api = await setupTestApi();
    const { project } = await createProject(api);
    const { token } = await api.pairMachine("自己的机器");
    const { machine: otherMachine } = await api.pairMachine("别的机器");

    const res = await PUT(
      api.request(`/api/v1/projects/${project.id}/locations/${otherMachine.id}`, { method: "PUT", token, json: { path: "/repo" } }),
      api.ctx({ id: project.id, machineId: otherMachine.id }),
    );

    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe("forbidden");
  });

  it("会话请求返回 403", async () => {
    api = await setupTestApi();
    const { project } = await createProject(api);
    const { machine } = await api.pairMachine();

    const res = await PUT(
      api.request(`/api/v1/projects/${project.id}/locations/${machine.id}`, {
        method: "PUT",
        cookie: api.sessionCookie(),
        json: { path: "/repo" },
      }),
      api.ctx({ id: project.id, machineId: machine.id }),
    );

    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe("forbidden");
  });

  it("项目不存在返回 404", async () => {
    api = await setupTestApi();
    const { token, machine } = await api.pairMachine();

    const res = await PUT(
      api.request(`/api/v1/projects/zzzzzzzzzz/locations/${machine.id}`, { method: "PUT", token, json: { path: "/repo" } }),
      api.ctx({ id: "zzzzzzzzzz", machineId: machine.id }),
    );

    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe("not_found");
  });

  it("事件里的操作者：via 为 cli，带 machineId 和 X-KH-Agent 给出的 agent", async () => {
    api = await setupTestApi();
    const { project } = await createProject(api);
    const { token, machine } = await api.pairMachine();

    await PUT(
      api.request(`/api/v1/projects/${project.id}/locations/${machine.id}`, {
        method: "PUT",
        token,
        headers: { [HEADER_KH_AGENT]: "claude-code" },
        json: { path: "/repo" },
      }),
      api.ctx({ id: project.id, machineId: machine.id }),
    );

    const events = await api.store.listEvents({ projectId: project.id, limit: 1 });
    expect(events[0]?.actor).toMatchObject({ via: "cli", machineId: machine.id, agent: "claude-code" });
    expect(events[0]?.change).toEqual({ location: { from: null, to: { machineId: machine.id, path: "/repo", sync: null } } });
  });
});
