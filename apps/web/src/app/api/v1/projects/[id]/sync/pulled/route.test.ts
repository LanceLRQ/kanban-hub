import { afterEach, describe, expect, it } from "vitest";
import type { Actor, Event, Project } from "@kanban-hub/core/schema";
import { setupTestApi, type TestApi } from "@/server/api/testing";
import { POST } from "./route";

async function createProject(api: TestApi): Promise<{ project: Project; token: string }> {
  const { token, machine } = await api.pairMachine();
  const actor: Actor = { userId: machine.userId, machineId: machine.id, via: "cli", agent: null };
  const { project } = await api.store.createProject({ name: "拉取上报测试项目" }, actor);
  return { project, token };
}

describe("POST /api/v1/projects/:id/sync/pulled", () => {
  let api: TestApi;

  afterEach(async () => {
    await api?.cleanup();
  });

  it("计数全为 0 时返回 400", async () => {
    api = await setupTestApi();
    const { project, token } = await createProject(api);

    const res = await POST(
      api.request(`/api/v1/projects/${project.id}/sync/pulled`, {
        method: "POST",
        token,
        json: { created: 0, overwritten: 0, merged: 0, conflicts: 0, stale: 0, fromMachineIds: [] },
      }),
      api.ctx({ id: project.id }),
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid");
  });

  it("有计数时记一条 docs.pulled 事件", async () => {
    api = await setupTestApi();
    const { project, token } = await createProject(api);
    const { machine: other } = await api.pairMachine("对方机器");

    const res = await POST(
      api.request(`/api/v1/projects/${project.id}/sync/pulled`, {
        method: "POST",
        token,
        json: { created: 1, overwritten: 0, merged: 2, conflicts: 1, stale: 0, fromMachineIds: [other.id] },
      }),
      api.ctx({ id: project.id }),
    );

    expect(res.status).toBe(200);
    const events = await api.store.listEvents({ projectId: project.id, limit: 10 });
    const pulled = events.find((e: Event) => e.type === "docs.pulled");
    expect(pulled).toBeDefined();
    expect(pulled?.change).toMatchObject({
      created: { to: 1 },
      overwritten: { to: 0 },
      merged: { to: 2 },
      conflicts: { to: 1 },
      stale: { to: 0 },
      from: { to: [other.id] },
    });
  });
});
