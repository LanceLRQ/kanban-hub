import { afterEach, describe, expect, it } from "vitest";
import type { Actor, Container, Event } from "@kanban-hub/core/schema";
import { setupTestApi, type TestApi } from "@/server/api/testing";
import { POST } from "./route";

const actor: Actor = { userId: "0000000000", machineId: null, via: "web", agent: null };

async function seed(api: TestApi) {
  const { project } = await api.store.createProject({ name: "测试项目" }, actor);
  const a = await api.store.createContainer(project.id, { kind: "feature", title: "甲" }, actor);
  const b = await api.store.createContainer(project.id, { kind: "feature", title: "乙" }, actor);
  const c = await api.store.createContainer(project.id, { kind: "feature", title: "丙" }, actor);
  return { project, a, b, c };
}

function call(api: TestApi, projectId: string, body: unknown, withCookie = true) {
  return POST(
    api.request(`/api/v1/projects/${projectId}/reorder-containers`, {
      method: "POST",
      json: body,
      cookie: withCookie ? api.sessionCookie() : undefined,
    }),
    api.ctx({ id: projectId }),
  );
}

describe("POST /api/v1/projects/:id/reorder-containers", () => {
  let api: TestApi;

  afterEach(async () => {
    await api?.cleanup();
  });

  it("重排后返回全部容器的新顺序（杂项在最后），看板一致，事件正好新增一条", async () => {
    api = await setupTestApi();
    const { project, a, b, c } = await seed(api);
    const before = await api.store.listEvents({ projectId: project.id, limit: 100 });

    const res = await call(api, project.id, { containerIds: [c.id, a.id] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Container[];
    expect(body.map((x) => x.id).slice(0, 3)).toEqual([c.id, a.id, b.id]);
    expect(body[body.length - 1]!.kind).toBe("misc");
    expect(body).toHaveLength(4);

    const board = api.store.getBoard(project.id)!;
    const ordered = board.containers.filter((x) => x.kind !== "misc").sort((x, y) => x.order - y.order);
    expect(ordered.map((x) => x.id)).toEqual([c.id, a.id, b.id]);

    const after = await api.store.listEvents({ projectId: project.id, limit: 100 });
    expect(after.length).toBe(before.length + 1);
    expect(after.filter((e: Event) => e.type === "board.reordered")).toHaveLength(1);
  });

  it("顺序不变时返回 200，不追加事件", async () => {
    api = await setupTestApi();
    const { project, a } = await seed(api);
    const before = await api.store.listEvents({ projectId: project.id, limit: 100 });
    const res = await call(api, project.id, { containerIds: [a.id] });
    expect(res.status).toBe(200);
    const after = await api.store.listEvents({ projectId: project.id, limit: 100 });
    expect(after.length).toBe(before.length);
  });

  it("参数不合法返回 400（含杂项容器、重复 ID）", async () => {
    api = await setupTestApi();
    const { project, a } = await seed(api);
    const misc = api.store.getBoard(project.id)!.containers.find((x) => x.kind === "misc")!;
    expect((await call(api, project.id, { containerIds: [misc.id] })).status).toBe(400);
    expect((await call(api, project.id, { containerIds: [a.id, a.id] })).status).toBe(400);
    expect((await call(api, project.id, { containerIds: [] })).status).toBe(400);
  });

  it("未登录返回 401", async () => {
    api = await setupTestApi();
    const { project } = await seed(api);
    expect((await call(api, project.id, { containerIds: [] }, false)).status).toBe(401);
  });

  it("项目或容器不存在返回 404", async () => {
    api = await setupTestApi();
    const { project, a } = await seed(api);
    expect((await call(api, "zzzzzzzzzz", { containerIds: [a.id] })).status).toBe(404);
    expect((await call(api, project.id, { containerIds: ["zzzzzzzzzz"] })).status).toBe(404);
  });
});
