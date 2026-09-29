import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
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
      backups: [],
    });
    expect(view.pendingCommits).toBeGreaterThan(0);
  });

  it("备份列表来自备份目录，按创建时间倒序，其他文件不算", async () => {
    api = await setupTestApi();
    await fs.mkdir(api.backupDir, { recursive: true });
    await fs.writeFile(path.join(api.backupDir, "kanban-hub-20260920-030000.zip"), "旧");
    await fs.writeFile(path.join(api.backupDir, "kanban-hub-20260927-030000.zip"), "新");
    await fs.writeFile(path.join(api.backupDir, "随手放的.txt"), "不算");
    // 同一批写入的修改时间可能落在同一个时间粒度里，显式拉开才谈得上倒序
    const older = new Date(Date.now() - 60_000);
    await fs.utimes(path.join(api.backupDir, "kanban-hub-20260920-030000.zip"), older, older);

    const view = buildSettingsView(api.services);

    expect(view.backups.map((b) => b.fileName)).toEqual([
      "kanban-hub-20260927-030000.zip",
      "kanban-hub-20260920-030000.zip",
    ]);
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
