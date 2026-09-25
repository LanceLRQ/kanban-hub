import { afterEach, describe, expect, it } from "vitest";
import type { Actor } from "@kanban-hub/core/schema";
import { setupTestApi, type TestApi } from "@/server/api/testing";
import { buildProjectHeader } from "./project-header";

const NOW = new Date("2026-09-25T10:00:00.000Z");

let api: TestApi;

afterEach(async () => {
  await api.cleanup();
});

function webActor(api: TestApi): Actor {
  const admin = api.store.auth.listUsers().find((u) => u.role === "admin")!;
  return { userId: admin.id, machineId: null, via: "web", agent: null };
}

describe("buildProjectHeader", () => {
  it("项目不存在时返回 null", async () => {
    api = await setupTestApi();
    expect(buildProjectHeader(api.services, "no-such-project", NOW)).toBeNull();
  });

  it("没有登记任何位置时，位置摘要为 null", async () => {
    api = await setupTestApi();
    const { project } = await api.store.createProject({ name: "kanban-hub", cycle: "development", health: "on_track", focus: "M4" }, webActor(api));

    const view = buildProjectHeader(api.services, project.id, NOW);
    expect(view).not.toBeNull();
    expect(view?.location).toBeNull();
    expect(view).toMatchObject({ id: project.id, name: "kanban-hub", cycle: "development", health: "on_track", focus: "M4", version: project.version });
  });

  it("登记了位置时，取主位置并带上机器名", async () => {
    api = await setupTestApi();
    const { project } = await api.store.createProject({ name: "kanban-hub", cycle: "development", health: "on_track", focus: "M4" }, webActor(api));
    const { machine } = await api.pairMachine("mac-mini");
    await api.store.setLocation(project.id, machine.id, { path: "/repo" }, webActor(api));

    const view = buildProjectHeader(api.services, project.id, NOW);
    expect(view?.location).toMatchObject({ machineName: "mac-mini", path: "/repo" });
  });
});
