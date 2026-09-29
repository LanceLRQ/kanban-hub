import { afterEach, describe, expect, it } from "vitest";
import { importResponse } from "@kanban-hub/core/api";
import type { Actor, Project } from "@kanban-hub/core/schema";
import type { TransferDoc } from "@kanban-hub/core/transfer";
import { setupTestApi, type TestApi } from "@/server/api/testing";
import { POST } from "./route";

interface ErrorBody {
  error: { code: string; message: string; details?: { issues?: string[] } };
}

async function createProject(api: TestApi): Promise<{ project: Project; token: string; actor: Actor }> {
  const { machine, token } = await api.pairMachine();
  const actor: Actor = { userId: machine.userId, machineId: machine.id, via: "cli", agent: null };
  const { project } = await api.store.createProject({ name: "看板" }, actor);
  return { project, token, actor };
}

const DOC: TransferDoc = {
  format: "kanban-hub/v1",
  containers: [{ kind: "phase", code: "P0", title: "工程骨架", tasks: [{ code: "0.1", title: "初始化仓库", status: "done" }] }],
  events: [{ ts: "2026-01-05T18:00:00+08:00", text: "完成工程骨架" }],
};

describe("POST /api/v1/projects/:id/import", () => {
  let api: TestApi;

  afterEach(async () => {
    await api?.cleanup();
  });

  it("dryRun=1 只返回摘要、不写入；不带参数时写入，dryRun 字段如实反映", async () => {
    api = await setupTestApi();
    const { project, token } = await createProject(api);

    const dry = await POST(
      api.request(`/api/v1/projects/${project.id}/import?dryRun=1`, { method: "POST", json: DOC, token }),
      api.ctx({ id: project.id }),
    );
    expect(dry.status).toBe(200);
    const drySummary = importResponse.parse(await dry.json());
    expect(drySummary.dryRun).toBe(true);
    expect(drySummary.tasks.created).toEqual([{ container: "P0", title: "初始化仓库" }]);
    expect(api.store.getBoard(project.id)?.tasks).toEqual([]);

    const res = await POST(
      api.request(`/api/v1/projects/${project.id}/import`, { method: "POST", json: DOC, token }),
      api.ctx({ id: project.id }),
    );
    expect(res.status).toBe(200);
    const summary = importResponse.parse(await res.json());
    expect(summary.dryRun).toBe(false);
    expect(summary.events.added).toBe(1);
    expect(api.store.getBoard(project.id)?.tasks.map((t) => t.title)).toEqual(["初始化仓库"]);
  });

  it("网页会话也可以导入", async () => {
    api = await setupTestApi();
    const { project } = await createProject(api);
    const res = await POST(
      api.request(`/api/v1/projects/${project.id}/import`, { method: "POST", json: DOC, cookie: api.sessionCookie() }),
      api.ctx({ id: project.id }),
    );
    expect(res.status).toBe(200);
  });

  it("文件内容不合法时返回 400，details.issues 带字段路径，什么都不写", async () => {
    api = await setupTestApi();
    const { project, token } = await createProject(api);
    const bad = { ...DOC, containers: [{ kind: "phase", title: "阶段", tasks: [{ title: "任务", status: "unknown" }] }] };

    const res = await POST(
      api.request(`/api/v1/projects/${project.id}/import`, { method: "POST", json: bad, token }),
      api.ctx({ id: project.id }),
    );
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as ErrorBody;
    expect(error.code).toBe("invalid");
    expect(error.details?.issues?.join("\n")).toContain("containers[0].tasks[0].status");
    expect(api.store.getBoard(project.id)?.containers).toHaveLength(1);
  });

  it("dryRun 的取值不认识时返回 400", async () => {
    api = await setupTestApi();
    const { project, token } = await createProject(api);
    const res = await POST(
      api.request(`/api/v1/projects/${project.id}/import?dryRun=maybe`, { method: "POST", json: DOC, token }),
      api.ctx({ id: project.id }),
    );
    expect(res.status).toBe(400);
  });

  it("项目不存在时返回 404", async () => {
    api = await setupTestApi();
    const { token } = await createProject(api);
    const res = await POST(
      api.request("/api/v1/projects/zzzzzzzzzz/import", { method: "POST", json: DOC, token }),
      api.ctx({ id: "zzzzzzzzzz" }),
    );
    expect(res.status).toBe(404);
  });

  it("未登录时返回 401", async () => {
    api = await setupTestApi();
    const { project } = await createProject(api);
    const res = await POST(
      api.request(`/api/v1/projects/${project.id}/import`, { method: "POST", json: DOC }),
      api.ctx({ id: project.id }),
    );
    expect(res.status).toBe(401);
  });

  it("超过 1 MB、不超过 5 MB 的请求体照常接受", async () => {
    api = await setupTestApi();
    const { project, token } = await createProject(api);
    const events = Array.from({ length: 300 }, (_, i) => ({
      ts: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      text: `第 ${i} 条 ${"x".repeat(8000)}`,
    }));
    const res = await POST(
      api.request(`/api/v1/projects/${project.id}/import?dryRun=1`, { method: "POST", json: { ...DOC, events }, token }),
      api.ctx({ id: project.id }),
    );
    expect(res.status).toBe(200);
    expect(importResponse.parse(await res.json()).events.added).toBe(300);
  });

  it("请求体超过 5 MB 时返回 413", async () => {
    api = await setupTestApi();
    const { project, token } = await createProject(api);
    const huge = { ...DOC, events: [{ ts: "2026-01-05T18:00:00+08:00", text: "x".repeat(5 * 1024 * 1024) }] };
    const res = await POST(
      api.request(`/api/v1/projects/${project.id}/import`, { method: "POST", json: huge, token }),
      api.ctx({ id: project.id }),
    );
    expect(res.status).toBe(413);
  });
});
