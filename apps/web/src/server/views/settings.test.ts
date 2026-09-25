import { afterEach, describe, expect, it } from "vitest";
import { KH_VERSION } from "@kanban-hub/core/version";
import { setupTestApi, type TestApi } from "@/server/api/testing";
import { buildSettingsView } from "./settings";

let api: TestApi;

afterEach(async () => {
  await api.cleanup();
});

describe("buildSettingsView", () => {
  it("待提交改动数与存储一致，其余字段原样透传", async () => {
    api = await setupTestApi();
    const admin = api.store.auth.listUsers().find((u) => u.role === "admin")!;
    await api.store.createProject({ name: "看板" }, { userId: admin.id, machineId: null, via: "web", agent: null });

    const view = buildSettingsView(api.services);

    expect(view).toEqual({
      version: KH_VERSION,
      dataDirectory: api.services.store.dataDirectory,
      pendingCommits: api.services.store.pendingCommitCount(),
      publicUrl: null,
      staleDays: api.services.staleDays,
    });
    expect(view.pendingCommits).toBeGreaterThan(0);
  });

  it("publicUrl 为 null 时视图原样给出 null，不做任何显示文案的推断", async () => {
    api = await setupTestApi();
    expect(buildSettingsView(api.services).publicUrl).toBeNull();
  });

  it("配置了 publicUrl 时视图原样给出", async () => {
    api = await setupTestApi();
    api.services.publicUrl = "https://kanban.example.com";
    expect(buildSettingsView(api.services).publicUrl).toBe("https://kanban.example.com");
  });
});
