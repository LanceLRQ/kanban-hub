import { describe, expect, it } from "vitest";
import path from "node:path";
import { resolveServerPaths } from "./paths";

describe("resolveServerPaths", () => {
  it("未设置环境变量时默认放在 ~/.kanban-hub/server 下，且不视为容器环境", () => {
    const p = resolveServerPaths({}, "/home/alice");
    expect(p).toEqual({
      dataDir: path.join("/home/alice", ".kanban-hub", "server", "data"),
      backupDir: path.join("/home/alice", ".kanban-hub", "server", "backups"),
      inContainer: false,
    });
  });

  it("环境变量优先", () => {
    const p = resolveServerPaths(
      { KH_DATA_DIR: "/data", KH_BACKUP_DIR: "/backups", KH_IN_CONTAINER: "1" },
      "/home/alice",
    );
    expect(p).toEqual({ dataDir: "/data", backupDir: "/backups", inContainer: true });
  });

  it("KH_IN_CONTAINER 只有取值为 1 时才生效", () => {
    expect(resolveServerPaths({ KH_IN_CONTAINER: "true" }, "/h").inContainer).toBe(false);
  });
});
