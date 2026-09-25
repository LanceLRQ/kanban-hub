import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KH_VERSION } from "@kanban-hub/core/version";
import { GET } from "./route";

describe("GET /setup/kh.tgz", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("没有配置 KH_CLI_PACKAGE 时返回 404", async () => {
    vi.stubEnv("KH_CLI_PACKAGE", "");

    const res = await GET();

    expect(res.status).toBe(404);
  });

  it("配置的文件不存在时返回 404", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kh-setup-route-"));
    cleanupDirs.push(dir);
    vi.stubEnv("KH_CLI_PACKAGE", path.join(dir, "does-not-exist.tgz"));

    const res = await GET();

    expect(res.status).toBe(404);
  });

  it("文件存在时返回 200，响应体与文件字节一致，四个响应头都在", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kh-setup-route-"));
    cleanupDirs.push(dir);
    const tgzPath = path.join(dir, "kh.tgz");
    const fileBytes = new Uint8Array([31, 139, 8, 0, 1, 2, 3, 4]); // 内容无需是真正的 gzip，只验证字节透传
    await fs.writeFile(tgzPath, fileBytes);
    vi.stubEnv("KH_CLI_PACKAGE", tgzPath);

    const res = await GET();

    expect(res.status).toBe(200);
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body).toEqual(fileBytes);
    expect(res.headers.get("Content-Type")).toBe("application/gzip");
    expect(res.headers.get("Content-Disposition")).toBe(`attachment; filename="kh-${KH_VERSION}.tgz"`);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-KH-Version")).toBe(KH_VERSION);
  });
});
