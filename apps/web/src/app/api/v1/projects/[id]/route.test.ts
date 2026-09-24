import { afterEach, describe, expect, it } from "vitest";
import { HEADER_KH_AGENT } from "@kanban-hub/core/api";
import type { Actor, Project } from "@kanban-hub/core/schema";
import { setupTestApi, type TestApi } from "@/server/api/testing";
import { GET, PATCH } from "./route";

interface ErrorBody {
  error: { code: string; message: string; details?: { issues?: string[]; currentVersion?: number } };
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

describe("GET /api/v1/projects/:id", () => {
  let api: TestApi;

  afterEach(async () => {
    await api?.cleanup();
  });

  it("返回 project、board、lastEventAt", async () => {
    api = await setupTestApi();
    const { project } = await createProject(api);

    const res = await GET(api.request(`/api/v1/projects/${project.id}`, { cookie: api.sessionCookie() }), api.ctx({ id: project.id }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { project: Project; board: { containers: unknown[] }; lastEventAt: string | null };
    expect(body.project.id).toBe(project.id);
    expect(body.board.containers).toHaveLength(1);
    expect(body.lastEventAt).toBe(project.updatedAt);
  });

  it("项目不存在时返回 404", async () => {
    api = await setupTestApi();
    const res = await GET(api.request("/api/v1/projects/zzzzzzzzzz", { cookie: api.sessionCookie() }), api.ctx({ id: "zzzzzzzzzz" }));
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe("not_found");
  });
});

describe("PATCH /api/v1/projects/:id", () => {
  let api: TestApi;

  afterEach(async () => {
    await api?.cleanup();
  });

  it("网页传过期的 version，返回 409 并带 currentVersion", async () => {
    api = await setupTestApi();
    const { project } = await createProject(api);

    const res = await PATCH(
      api.request(`/api/v1/projects/${project.id}`, {
        method: "PATCH",
        cookie: api.sessionCookie(),
        json: { focus: "新焦点", version: project.version + 1 },
      }),
      api.ctx({ id: project.id }),
    );

    expect(res.status).toBe(409);
    expect((await errorOf(res)).details?.currentVersion).toBe(project.version);
  });

  it("kh 不传 version，直接生效", async () => {
    api = await setupTestApi();
    const { project } = await createProject(api);
    const { token } = await api.pairMachine();

    const res = await PATCH(
      api.request(`/api/v1/projects/${project.id}`, { method: "PATCH", token, json: { focus: "新焦点" } }),
      api.ctx({ id: project.id }),
    );

    expect(res.status).toBe(200);
    const updated = (await res.json()) as Project;
    expect(updated.focus).toBe("新焦点");
    expect(updated.version).toBe(project.version + 1);
  });

  it("修改没有变化时返回原对象，不产生事件", async () => {
    api = await setupTestApi();
    const { project } = await createProject(api);
    const before = await api.store.listEvents({ projectId: project.id, limit: 100 });

    const res = await PATCH(
      api.request(`/api/v1/projects/${project.id}`, { method: "PATCH", cookie: api.sessionCookie(), json: { name: project.name } }),
      api.ctx({ id: project.id }),
    );

    expect(res.status).toBe(200);
    const updated = (await res.json()) as Project;
    expect(updated).toEqual(project);
    const after = await api.store.listEvents({ projectId: project.id, limit: 100 });
    expect(after).toHaveLength(before.length);
  });

  it("项目不存在时返回 404", async () => {
    api = await setupTestApi();
    const res = await PATCH(
      api.request("/api/v1/projects/zzzzzzzzzz", { method: "PATCH", cookie: api.sessionCookie(), json: { focus: "x" } }),
      api.ctx({ id: "zzzzzzzzzz" }),
    );
    expect(res.status).toBe(404);
  });

  it("事件里的操作者：令牌请求 via 为 cli，带 machineId 和 agent；会话请求 via 为 web", async () => {
    api = await setupTestApi();
    const { project } = await createProject(api);
    const { token, machine } = await api.pairMachine("第二台机器");

    await PATCH(
      api.request(`/api/v1/projects/${project.id}`, {
        method: "PATCH",
        token,
        headers: { [HEADER_KH_AGENT]: "claude-code" },
        json: { focus: "来自 cli" },
      }),
      api.ctx({ id: project.id }),
    );
    const afterToken = await api.store.listEvents({ projectId: project.id, limit: 1 });
    expect(afterToken[0]?.actor).toMatchObject({ via: "cli", machineId: machine.id, agent: "claude-code" });

    await PATCH(
      api.request(`/api/v1/projects/${project.id}`, { method: "PATCH", cookie: api.sessionCookie(), json: { focus: "来自网页" } }),
      api.ctx({ id: project.id }),
    );
    const afterSession = await api.store.listEvents({ projectId: project.id, limit: 1 });
    expect(afterSession[0]?.actor).toMatchObject({ via: "web", machineId: null });
  });
});
