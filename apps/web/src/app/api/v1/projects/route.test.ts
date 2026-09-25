import { afterEach, describe, expect, it } from "vitest";
import { HEADER_KH_AGENT, projectCreatedResponse, projectListResponse } from "@kanban-hub/core/api";
import type { Project } from "@kanban-hub/core/schema";
import { setupTestApi, type TestApi } from "@/server/api/testing";
import { GET, POST } from "./route";

interface ErrorBody {
  error: { code: string; message: string; details?: { issues?: string[]; currentVersion?: number } };
}

async function errorOf(res: Response): Promise<ErrorBody["error"]> {
  return ((await res.json()) as ErrorBody).error;
}

describe("POST /api/v1/projects", () => {
  let api: TestApi;

  afterEach(async () => {
    await api?.cleanup();
  });

  it("新建项目：返回 201，自动带一个杂项容器", async () => {
    api = await setupTestApi();
    const res = await POST(api.request("/api/v1/projects", { method: "POST", cookie: api.sessionCookie(), json: { name: "看板" } }), api.ctx({}));

    expect(res.status).toBe(201);
    const body = projectCreatedResponse.parse(await res.json());
    expect(body.project.name).toBe("看板");
    expect(body.board.containers).toHaveLength(1);
    expect(body.board.containers[0]?.kind).toBe("misc");
  });

  it("请求体有未知字段时返回 400，带 issues", async () => {
    api = await setupTestApi();
    const res = await POST(
      api.request("/api/v1/projects", { method: "POST", cookie: api.sessionCookie(), json: { name: "看板", unknown: 1 } }),
      api.ctx({}),
    );

    expect(res.status).toBe(400);
    const error = await errorOf(res);
    expect(error.code).toBe("invalid");
    expect(error.details?.issues?.length).toBeGreaterThan(0);
  });

  it("名字为空时返回 400，带 issues", async () => {
    api = await setupTestApi();
    const res = await POST(api.request("/api/v1/projects", { method: "POST", cookie: api.sessionCookie(), json: { name: "" } }), api.ctx({}));

    expect(res.status).toBe(400);
    const error = await errorOf(res);
    expect(error.code).toBe("invalid");
    expect(error.details?.issues?.length).toBeGreaterThan(0);
  });

  it("事件里的操作者：令牌请求 via 为 cli，带 machineId 和 X-KH-Agent 给出的 agent", async () => {
    api = await setupTestApi();
    const { token, machine } = await api.pairMachine();
    const res = await POST(
      api.request("/api/v1/projects", {
        method: "POST",
        token,
        headers: { [HEADER_KH_AGENT]: "claude-code" },
        json: { name: "看板" },
      }),
      api.ctx({}),
    );
    expect(res.status).toBe(201);
    const { project } = (await res.json()) as { project: Project };

    const events = await api.store.listEvents({ projectId: project.id, limit: 10 });
    expect(events[0]?.actor).toMatchObject({ via: "cli", machineId: machine.id, agent: "claude-code" });
  });

  it("事件里的操作者：会话请求 via 为 web", async () => {
    api = await setupTestApi();
    const res = await POST(api.request("/api/v1/projects", { method: "POST", cookie: api.sessionCookie(), json: { name: "看板" } }), api.ctx({}));
    expect(res.status).toBe(201);
    const { project } = (await res.json()) as { project: Project };

    const events = await api.store.listEvents({ projectId: project.id, limit: 10 });
    expect(events[0]?.actor).toMatchObject({ via: "web", machineId: null });
  });
});

describe("GET /api/v1/projects", () => {
  let api: TestApi;

  afterEach(async () => {
    await api?.cleanup();
  });

  it("列出全部项目，带上 lastEventAt", async () => {
    api = await setupTestApi();
    const { machine } = await api.pairMachine();
    const { project } = await api.store.createProject(
      { name: "看板" },
      { userId: machine.userId, machineId: machine.id, via: "cli", agent: null },
    );

    const res = await GET(api.request("/api/v1/projects", { cookie: api.sessionCookie() }), api.ctx({}));
    expect(res.status).toBe(200);
    const body = projectListResponse.parse(await res.json());
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0]?.project.id).toBe(project.id);
    expect(body.projects[0]?.lastEventAt).toBe(project.updatedAt);
    expect(body.projects[0]?.stale).toBe(false);
  });

  it("stale 随 staleDays 与经过的时间变化", async () => {
    api = await setupTestApi();
    const { machine } = await api.pairMachine();
    const { project } = await api.store.createProject(
      { name: "看板" },
      { userId: machine.userId, machineId: machine.id, via: "cli", agent: null },
    );
    const createdMs = Date.parse(project.createdAt);
    api.services.now = () => new Date(createdMs + 8 * 86_400_000);

    api.services.staleDays = 7;
    const staleRes = await GET(api.request("/api/v1/projects", { cookie: api.sessionCookie() }), api.ctx({}));
    const staleBody = projectListResponse.parse(await staleRes.json());
    expect(staleBody.projects[0]?.stale).toBe(true);

    api.services.staleDays = 30;
    const freshRes = await GET(api.request("/api/v1/projects", { cookie: api.sessionCookie() }), api.ctx({}));
    const freshBody = projectListResponse.parse(await freshRes.json());
    expect(freshBody.projects[0]?.stale).toBe(false);
  });

  it("按指纹查询：能命中，也能对不上时返回空列表", async () => {
    api = await setupTestApi();
    const { machine } = await api.pairMachine();
    const fingerprint = "a".repeat(40);
    await api.store.createProject(
      { name: "看板", fingerprint },
      { userId: machine.userId, machineId: machine.id, via: "cli", agent: null },
    );

    const hit = await GET(api.request(`/api/v1/projects?fingerprint=${fingerprint}`, { cookie: api.sessionCookie() }), api.ctx({}));
    const hitBody = (await hit.json()) as { projects: unknown[] };
    expect(hitBody.projects).toHaveLength(1);

    const miss = await GET(api.request(`/api/v1/projects?fingerprint=${"b".repeat(40)}`, { cookie: api.sessionCookie() }), api.ctx({}));
    const missBody = (await miss.json()) as { projects: unknown[] };
    expect(missBody.projects).toHaveLength(0);
  });

  it("指纹格式不对时不报错，直接返回空列表", async () => {
    api = await setupTestApi();
    const res = await GET(api.request("/api/v1/projects?fingerprint=not-a-hash", { cookie: api.sessionCookie() }), api.ctx({}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projects: unknown[] };
    expect(body.projects).toHaveLength(0);
  });
});
