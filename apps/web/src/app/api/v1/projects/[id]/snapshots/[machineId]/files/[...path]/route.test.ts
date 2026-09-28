import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { Actor, Machine, Project } from "@kanban-hub/core/schema";
import { setupTestApi, type TestApi } from "@/server/api/testing";
import { POST as syncManifestPost } from "../../../../sync/manifest/route";
import { PUT as syncBlobPut } from "../../../../sync/blobs/[sha256]/route";
import { POST as syncCommitPost } from "../../../../sync/commit/route";
import { GET } from "./route";

const scope = { include: ["**"], exclude: [], maxFileSize: 5 * 1024 * 1024 };

function fileEntry(path: string, content: string) {
  const bytes = new TextEncoder().encode(content);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { bytes, entry: { path, sha256, size: bytes.length, mtime: 1_710_000_000_000, base: null as string | null } };
}

async function projectWithSyncedFile(api: TestApi): Promise<{ project: Project; machine: Machine; token: string }> {
  const { token, machine } = await api.pairMachine();
  const actor: Actor = { userId: machine.userId, machineId: machine.id, via: "cli", agent: null };
  const { project } = await api.store.createProject({ name: "快照文件读取测试项目" }, actor);
  await api.store.setLocation(project.id, machine.id, { path: "/repo" }, actor);

  const file = fileEntry("docs/README.md", "文件内容");
  const manifestRes = await syncManifestPost(
    api.request(`/api/v1/projects/${project.id}/sync/manifest`, {
      method: "POST",
      token,
      json: { files: [file.entry], git: null, skipped: [], scope },
    }),
    api.ctx({ id: project.id }),
  );
  const { syncId } = (await manifestRes.json()) as { syncId: string };
  await syncBlobPut(
    new Request(`http://localhost/api/v1/projects/${project.id}/sync/blobs/${file.entry.sha256}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, host: "localhost", origin: "http://localhost" },
      body: file.bytes,
    }),
    api.ctx({ id: project.id, sha256: file.entry.sha256 }),
  );
  await syncCommitPost(
    api.request(`/api/v1/projects/${project.id}/sync/commit`, { method: "POST", token, json: { syncId } }),
    api.ctx({ id: project.id }),
  );

  return { project, machine, token };
}

describe("GET /api/v1/projects/:id/snapshots/:machineId/files/*path", () => {
  let api: TestApi;

  afterEach(async () => {
    await api?.cleanup();
  });

  it("正常读取：字节内容与 X-KH-Sha256 头一致", async () => {
    api = await setupTestApi();
    const { project, machine, token } = await projectWithSyncedFile(api);

    const res = await GET(
      api.request(`/api/v1/projects/${project.id}/snapshots/${machine.id}/files/docs/README.md`, { token }),
      api.ctx({ id: project.id, machineId: machine.id, path: ["docs", "README.md"] }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes)).toBe("文件内容");
    expect(res.headers.get("X-KH-Sha256")).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it.each([
    ["路径穿越到数据仓库的鉴权目录", ["..", "..", "auth", "users.yaml"]],
    ["路径段包含 .git", ["a", ".git", "config"]],
    ["不在清单里的路径", ["not-synced.md"]],
  ])("%s：不会读到快照目录之外的内容，返回 404 或 400", async (_label, path) => {
    api = await setupTestApi();
    const { project, machine, token } = await projectWithSyncedFile(api);

    const res = await GET(
      api.request(`/api/v1/projects/${project.id}/snapshots/${machine.id}/files/${path.join("/")}`, { token }),
      api.ctx({ id: project.id, machineId: machine.id, path }),
    );

    expect([400, 404]).toContain(res.status);
  });

  it("426 与 X-KH-Version 响应头照常生效", async () => {
    api = await setupTestApi();
    const { project, machine, token } = await projectWithSyncedFile(api);

    const res = await GET(
      api.request(`/api/v1/projects/${project.id}/snapshots/${machine.id}/files/docs/README.md`, {
        token,
        headers: { "x-kh-version": "0.0.1" },
      }),
      api.ctx({ id: project.id, machineId: machine.id, path: ["docs", "README.md"] }),
    );

    expect(res.status).toBe(426);
    expect(res.headers.get("X-KH-Version")).toBeTruthy();
  });
});
