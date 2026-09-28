import { afterEach, describe, expect, it } from "vitest";
import type { Actor } from "@kanban-hub/core/schema";
import { setupTestApi, type TestApi } from "@/server/api/testing";
import { GET } from "./route";

const prepActor: Actor = { userId: "0000000000", machineId: null, via: "web", agent: null };

describe("GET /api/v1/projects/:id/docs", () => {
  let api: TestApi;

  afterEach(async () => {
    await api?.cleanup();
  });

  it("返回 buildDocsView 里除 file 与 rawToken 之外的部分", async () => {
    api = await setupTestApi();
    const { project } = await api.store.createProject({ name: "测试项目" }, prepActor);
    const { token: machineToken } = await api.pairMachine();

    const res = await GET(api.request(`/api/v1/projects/${project.id}/docs`, { token: machineToken }), api.ctx({ id: project.id }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("machines");
    expect(body).toHaveProperty("tree");
    expect(body).toHaveProperty("recent");
    expect(body).toHaveProperty("emptyReason");
    expect(body).not.toHaveProperty("file");
    expect(body).not.toHaveProperty("rawToken");
    expect(body.emptyReason).toBe("no-sync");
  });

  it("会话与机器令牌都能调用（鉴权 any）", async () => {
    api = await setupTestApi();
    const { project } = await api.store.createProject({ name: "测试项目" }, prepActor);

    const res = await GET(api.request(`/api/v1/projects/${project.id}/docs`, { cookie: api.sessionCookie() }), api.ctx({ id: project.id }));
    expect(res.status).toBe(200);
  });

  it("项目不存在时返回 404", async () => {
    api = await setupTestApi();
    const { token } = await api.pairMachine();
    const res = await GET(api.request("/api/v1/projects/0000000000/docs", { token }), api.ctx({ id: "0000000000" }));
    expect(res.status).toBe(404);
  });
});
