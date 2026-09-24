import { afterEach, describe, expect, it } from "vitest";
import { HEADER_KH_AGENT } from "@kanban-hub/core/api";
import type { Actor, Event } from "@kanban-hub/core/schema";
import { setupTestApi, type TestApi } from "@/server/api/testing";
import { POST } from "./route";

// 准备前置数据（项目、容器）时直接调用 store 的写方法，不经过路由；这个 actor 只用于铺垫数据
const prepActor: Actor = { userId: "0000000000", machineId: null, via: "web", agent: null };

describe("POST /api/v1/projects/:id/containers", () => {
  let api: TestApi;

  afterEach(async () => {
    await api?.cleanup();
  });

  it("成功创建容器，返回 201 并记录操作者", async () => {
    api = await setupTestApi();
    const { project } = await api.store.createProject({ name: "测试项目" }, prepActor);
    const { token } = await api.pairMachine();

    const res = await POST(
      api.request(`/api/v1/projects/${project.id}/containers`, {
        method: "POST",
        json: { kind: "feature", title: "阶段一" },
        token,
        headers: { [HEADER_KH_AGENT]: "claude-code" },
      }),
      api.ctx({ id: project.id }),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { kind: string; title: string };
    expect(body.kind).toBe("feature");
    expect(body.title).toBe("阶段一");

    const events = await api.store.listEvents({ projectId: project.id, limit: 10 });
    const created = events.find((e: Event) => e.type === "container.created");
    expect(created?.actor.via).toBe("cli");
    expect(created?.actor.agent).toBe("claude-code");
  });

  it("kind 为 misc 时返回 400", async () => {
    api = await setupTestApi();
    const { project } = await api.store.createProject({ name: "测试项目" }, prepActor);
    const { token } = await api.pairMachine();

    const res = await POST(
      api.request(`/api/v1/projects/${project.id}/containers`, {
        method: "POST",
        json: { kind: "misc", title: "杂项" },
        token,
      }),
      api.ctx({ id: project.id }),
    );
    expect(res.status).toBe(400);
  });

  it("编号为 misc 时返回 400", async () => {
    api = await setupTestApi();
    const { project } = await api.store.createProject({ name: "测试项目" }, prepActor);
    const { token } = await api.pairMachine();

    const res = await POST(
      api.request(`/api/v1/projects/${project.id}/containers`, {
        method: "POST",
        json: { kind: "feature", title: "阶段一", code: "misc" },
        token,
      }),
      api.ctx({ id: project.id }),
    );
    expect(res.status).toBe(400);
  });

  it("项目不存在时返回 404", async () => {
    api = await setupTestApi();
    const { token } = await api.pairMachine();

    const res = await POST(
      api.request("/api/v1/projects/0000000000/containers", {
        method: "POST",
        json: { kind: "feature", title: "阶段一" },
        token,
      }),
      api.ctx({ id: "0000000000" }),
    );
    expect(res.status).toBe(404);
  });
});
