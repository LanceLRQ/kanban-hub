import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { Actor, Machine, Project } from "@kanban-hub/core/schema";
import { setupTestApi, type TestApi } from "@/server/api/testing";
import { POST as syncManifestPost } from "../../sync/manifest/route";
import { PUT as syncBlobPut } from "../../sync/blobs/[sha256]/route";
import { POST as syncCommitPost } from "../../sync/commit/route";
import { GET } from "./route";

const scope = { include: ["**"], exclude: [], maxFileSize: 5 * 1024 * 1024 };

function fileEntry(path: string, content: string) {
  const bytes = new TextEncoder().encode(content);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { bytes, entry: { path, sha256, size: bytes.length, mtime: 1_710_000_000_000, base: null as string | null } };
}

/** 用一台机器同步一份内容，走完整的三步协议 */
async function syncOneFile(api: TestApi, project: Project, token: string, path: string, content: string): Promise<void> {
  const file = fileEntry(path, content);
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
  const commitRes = await syncCommitPost(
    api.request(`/api/v1/projects/${project.id}/sync/commit`, { method: "POST", token, json: { syncId } }),
    api.ctx({ id: project.id }),
  );
  expect(commitRes.status).toBe(200);
}

async function setUpProjectAndMachine(api: TestApi, name: string): Promise<{ project: Project; machine: Machine; token: string }> {
  const { token, machine } = await api.pairMachine(name);
  const actor: Actor = { userId: machine.userId, machineId: machine.id, via: "cli", agent: null };
  const { project } = await api.store.createProject({ name: "latest-manifest 测试项目" }, actor);
  await api.store.setLocation(project.id, machine.id, { path: "/repo" }, actor);
  return { project, machine, token };
}

describe("GET /api/v1/projects/:id/snapshots/latest-manifest", () => {
  let api: TestApi;

  afterEach(async () => {
    await api?.cleanup();
  });

  it("三台机器各自同步了不同文件，返回全部机器与它们各自的文件", async () => {
    api = await setupTestApi();
    const { project, machine: a, token: tokenA } = await setUpProjectAndMachine(api, "机器 A");
    const { machine: b, token: tokenB } = await api.pairMachine("机器 B");
    const { machine: c, token: tokenC } = await api.pairMachine("机器 C");
    await api.store.setLocation(project.id, b.id, { path: "/repo" }, { userId: b.userId, machineId: b.id, via: "cli", agent: null });
    await api.store.setLocation(project.id, c.id, { path: "/repo" }, { userId: c.userId, machineId: c.id, via: "cli", agent: null });

    await syncOneFile(api, project, tokenA, "a.md", "机器 A 的内容");
    await syncOneFile(api, project, tokenB, "b.md", "机器 B 的内容");
    await syncOneFile(api, project, tokenC, "c.md", "机器 C 的内容");

    const res = await GET(api.request(`/api/v1/projects/${project.id}/snapshots/latest-manifest`, { token: tokenA }), api.ctx({ id: project.id }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      files: { path: string; machineId: string }[];
      machines: { id: string; name: string; lastSyncAt: string | null }[];
    };
    expect(body.files.map((f) => f.path).sort()).toEqual(["a.md", "b.md", "c.md"]);
    expect(body.machines.map((m) => m.id).sort()).toEqual([a.id, b.id, c.id].sort());
    for (const m of body.machines) {
      expect(m.lastSyncAt).not.toBeNull();
    }
  });

  it("exclude 生效：排除的机器的文件不出现在结果里", async () => {
    api = await setupTestApi();
    const { project, machine: a, token: tokenA } = await setUpProjectAndMachine(api, "机器 A");
    const { machine: b, token: tokenB } = await api.pairMachine("机器 B");
    await api.store.setLocation(project.id, b.id, { path: "/repo" }, { userId: b.userId, machineId: b.id, via: "cli", agent: null });

    await syncOneFile(api, project, tokenA, "a.md", "A");
    await syncOneFile(api, project, tokenB, "b.md", "B");

    const res = await GET(
      api.request(`/api/v1/projects/${project.id}/snapshots/latest-manifest?exclude=${a.id}`, { token: tokenA }),
      api.ctx({ id: project.id }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: { path: string; machineId: string }[] };
    expect(body.files.map((f) => f.path)).toEqual(["b.md"]);
  });

  it("exclude 不合法时返回 400", async () => {
    api = await setupTestApi();
    const { project, token } = await setUpProjectAndMachine(api, "机器 A");

    const res = await GET(
      api.request(`/api/v1/projects/${project.id}/snapshots/latest-manifest?exclude=不是ID`, { token }),
      api.ctx({ id: project.id }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid");
  });
});
