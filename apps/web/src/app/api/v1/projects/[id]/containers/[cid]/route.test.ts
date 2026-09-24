import { afterEach, describe, expect, it } from "vitest";
import type { Actor, Event } from "@kanban-hub/core/schema";
import { setupTestApi, type TestApi } from "@/server/api/testing";
import { PATCH } from "./route";

const prepActor: Actor = { userId: "0000000000", machineId: null, via: "web", agent: null };

describe("PATCH /api/v1/projects/:id/containers/:cid", () => {
  let api: TestApi;

  afterEach(async () => {
    await api?.cleanup();
  });

  it("成功修改容器，返回 200 并记录操作者", async () => {
    api = await setupTestApi();
    const { project } = await api.store.createProject({ name: "测试项目" }, prepActor);
    const container = await api.store.createContainer(project.id, { kind: "feature", title: "阶段一" }, prepActor);

    const res = await PATCH(
      api.request(`/api/v1/projects/${project.id}/containers/${container.id}`, {
        method: "PATCH",
        json: { title: "阶段一改" },
        cookie: api.sessionCookie(),
      }),
      api.ctx({ id: project.id, cid: container.id }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string };
    expect(body.title).toBe("阶段一改");

    const events = await api.store.listEvents({ projectId: project.id, limit: 10 });
    const updated = events.find((e: Event) => e.type === "container.updated");
    expect(updated?.actor.via).toBe("web");
  });

  it("挂起时没填原因，返回 400", async () => {
    api = await setupTestApi();
    const { project } = await api.store.createProject({ name: "测试项目" }, prepActor);
    const container = await api.store.createContainer(project.id, { kind: "feature", title: "阶段一" }, prepActor);

    const res = await PATCH(
      api.request(`/api/v1/projects/${project.id}/containers/${container.id}`, {
        method: "PATCH",
        json: { manualStatus: "suspended" },
        cookie: api.sessionCookie(),
      }),
      api.ctx({ id: project.id, cid: container.id }),
    );
    expect(res.status).toBe(400);
  });

  it("带过期的 version，返回 409 并带 currentVersion", async () => {
    api = await setupTestApi();
    const { project } = await api.store.createProject({ name: "测试项目" }, prepActor);
    const container = await api.store.createContainer(project.id, { kind: "feature", title: "阶段一" }, prepActor);

    const res = await PATCH(
      api.request(`/api/v1/projects/${project.id}/containers/${container.id}`, {
        method: "PATCH",
        json: { title: "新标题", version: container.version + 99 },
        cookie: api.sessionCookie(),
      }),
      api.ctx({ id: project.id, cid: container.id }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { details?: { currentVersion?: number } } };
    expect(body.error.details?.currentVersion).toBe(container.version);
  });

  it("容器不存在时返回 404", async () => {
    api = await setupTestApi();
    const { project } = await api.store.createProject({ name: "测试项目" }, prepActor);

    const res = await PATCH(
      api.request(`/api/v1/projects/${project.id}/containers/0000000000`, {
        method: "PATCH",
        json: { title: "新标题" },
        cookie: api.sessionCookie(),
      }),
      api.ctx({ id: project.id, cid: "0000000000" }),
    );
    expect(res.status).toBe(404);
  });
});
