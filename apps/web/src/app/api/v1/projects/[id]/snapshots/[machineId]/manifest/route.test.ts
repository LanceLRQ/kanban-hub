import { afterEach, describe, expect, it } from "vitest";
import type { Actor, Project } from "@kanban-hub/core/schema";
import { setupTestApi, type TestApi } from "@/server/api/testing";
import { GET } from "./route";

async function createProjectWithMachine(api: TestApi): Promise<{ project: Project; machineId: string }> {
  const { machine } = await api.pairMachine();
  const actor: Actor = { userId: machine.userId, machineId: machine.id, via: "cli", agent: null };
  const { project } = await api.store.createProject({ name: "快照清单测试项目" }, actor);
  return { project, machineId: machine.id };
}

describe("GET /api/v1/projects/:id/snapshots/:machineId/manifest", () => {
  let api: TestApi;

  afterEach(async () => {
    await api?.cleanup();
  });

  it("这台机器还没有同步过时返回 404", async () => {
    api = await setupTestApi();
    const { project, machineId } = await createProjectWithMachine(api);
    const { token } = await api.pairMachine("读取用机器");

    const res = await GET(
      api.request(`/api/v1/projects/${project.id}/snapshots/${machineId}/manifest`, { token }),
      api.ctx({ id: project.id, machineId }),
    );

    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });

  it("项目不存在时返回 404", async () => {
    api = await setupTestApi();
    const { token } = await api.pairMachine();

    const res = await GET(api.request(`/api/v1/projects/zzzzzzzzzz/snapshots/mmmmmmmmmm/manifest`, { token }), api.ctx({ id: "zzzzzzzzzz", machineId: "mmmmmmmmmm" }));

    expect(res.status).toBe(404);
  });
});
