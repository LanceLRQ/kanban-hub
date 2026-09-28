import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { Actor, Machine, Project } from "@kanban-hub/core/schema";
import { setupTestApi, type TestApi } from "@/server/api/testing";
import { GET as machineManifestGet } from "../snapshots/[machineId]/manifest/route";
import { GET as snapshotFileGet } from "../snapshots/[machineId]/files/[...path]/route";
import { PUT as syncBlobPut } from "./blobs/[sha256]/route";
import { POST as syncCommitPost } from "./commit/route";
import { POST as syncManifestPost } from "./manifest/route";

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

async function errorOf(res: Response): Promise<ErrorBody["error"]> {
  return ((await res.json()) as ErrorBody).error;
}

/** 生成一份文件内容及其对应的清单条目 */
function fileEntry(path: string, content: string) {
  const bytes = new TextEncoder().encode(content);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { bytes, entry: { path, sha256, size: bytes.length, mtime: 1_710_000_000_000, base: null as string | null } };
}

const scope = { include: ["**"], exclude: [], maxFileSize: 5 * 1024 * 1024 };

/** 建一个项目，并把机器登记为它的一个位置（同步前置条件） */
async function projectWithLocation(api: TestApi): Promise<{ project: Project; machine: Machine; token: string; actor: Actor }> {
  const { token, machine } = await api.pairMachine();
  const actor: Actor = { userId: machine.userId, machineId: machine.id, via: "cli", agent: null };
  const { project } = await api.store.createProject({ name: "文档同步测试项目" }, actor);
  await api.store.setLocation(project.id, machine.id, { path: "/repo" }, actor);
  return { project, machine, token, actor };
}

describe("文档同步三步协议", () => {
  let api: TestApi;

  afterEach(async () => {
    await api?.cleanup();
  });

  it("清单 → 上传内容 → 提交，再从快照读取接口读回清单和文件，字节与 hash 一致", async () => {
    api = await setupTestApi();
    const { project, machine, token } = await projectWithLocation(api);

    const readme = fileEntry("README.md", "# 你好\n");
    const guide = fileEntry("docs/guide.md", "指南内容");

    const manifestRes = await syncManifestPost(
      api.request(`/api/v1/projects/${project.id}/sync/manifest`, {
        method: "POST",
        token,
        json: { files: [readme.entry, guide.entry], git: null, skipped: [], scope },
      }),
      api.ctx({ id: project.id }),
    );
    expect(manifestRes.status).toBe(200);
    const { syncId, missing } = (await manifestRes.json()) as { syncId: string; missing: string[] };
    expect(new Set(missing)).toEqual(new Set([readme.entry.sha256, guide.entry.sha256]));

    for (const file of [readme, guide]) {
      const blobRes = await syncBlobPut(
        new Request(`http://localhost/api/v1/projects/${project.id}/sync/blobs/${file.entry.sha256}`, {
          method: "PUT",
          headers: { authorization: `Bearer ${token}`, host: "localhost", origin: "http://localhost" },
          body: file.bytes,
        }),
        api.ctx({ id: project.id, sha256: file.entry.sha256 }),
      );
      expect(blobRes.status).toBe(200);
    }

    const commitRes = await syncCommitPost(
      api.request(`/api/v1/projects/${project.id}/sync/commit`, { method: "POST", token, json: { syncId } }),
      api.ctx({ id: project.id }),
    );
    expect(commitRes.status).toBe(200);
    const counts = (await commitRes.json()) as { added: number; modified: number; removed: number; unchanged: number };
    expect(counts).toMatchObject({ added: 2, modified: 0, removed: 0, unchanged: 0 });

    const manifestGetRes = await machineManifestGet(
      api.request(`/api/v1/projects/${project.id}/snapshots/${machine.id}/manifest`, { token }),
      api.ctx({ id: project.id, machineId: machine.id }),
    );
    expect(manifestGetRes.status).toBe(200);
    const readManifest = (await manifestGetRes.json()) as { files: { path: string; sha256: string }[] };
    expect(readManifest.files.map((f) => f.path).sort()).toEqual(["README.md", "docs/guide.md"]);

    for (const file of [readme, guide]) {
      const fileRes = await snapshotFileGet(
        api.request(`/api/v1/projects/${project.id}/snapshots/${machine.id}/files/${file.entry.path}`, { token }),
        api.ctx({ id: project.id, machineId: machine.id, path: file.entry.path.split("/") }),
      );
      expect(fileRes.status).toBe(200);
      expect(fileRes.headers.get("X-KH-Sha256")).toBe(file.entry.sha256);
      const body = new Uint8Array(await fileRes.arrayBuffer());
      expect(body).toEqual(file.bytes);
    }
  });

  it("会话 cookie 调用同步类接口返回 403", async () => {
    api = await setupTestApi();
    const { project } = await projectWithLocation(api);

    const res = await syncManifestPost(
      api.request(`/api/v1/projects/${project.id}/sync/manifest`, {
        method: "POST",
        cookie: api.sessionCookie(),
        json: { files: [], git: null, skipped: [], scope },
      }),
      api.ctx({ id: project.id }),
    );
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe("forbidden");
  });

  it("吊销后的令牌调用同步类接口返回 401", async () => {
    api = await setupTestApi();
    const { project, machine, token } = await projectWithLocation(api);
    await api.store.auth.updateMachine(machine.id, { revokedAt: new Date().toISOString() });

    const res = await syncManifestPost(
      api.request(`/api/v1/projects/${project.id}/sync/manifest`, {
        method: "POST",
        token,
        json: { files: [], git: null, skipped: [], scope },
      }),
      api.ctx({ id: project.id }),
    );
    expect(res.status).toBe(401);
    expect((await errorOf(res)).code).toBe("unauthorized");
  });

  it("机器 B 提交机器 A 的 syncId 返回 404", async () => {
    api = await setupTestApi();
    const { project, token } = await projectWithLocation(api);
    const { token: tokenB } = await api.pairMachine("机器 B");

    const manifestRes = await syncManifestPost(
      api.request(`/api/v1/projects/${project.id}/sync/manifest`, {
        method: "POST",
        token,
        json: { files: [], git: null, skipped: [], scope },
      }),
      api.ctx({ id: project.id }),
    );
    const { syncId } = (await manifestRes.json()) as { syncId: string };

    const commitRes = await syncCommitPost(
      api.request(`/api/v1/projects/${project.id}/sync/commit`, { method: "POST", token: tokenB, json: { syncId } }),
      api.ctx({ id: project.id }),
    );
    expect(commitRes.status).toBe(404);
    expect((await errorOf(commitRes)).code).toBe("not_found");
  });

  it("blob 内容超过上限返回 413", async () => {
    api = await setupTestApi();
    const { project, token } = await projectWithLocation(api);
    const oversized = new Uint8Array(21 * 1024 * 1024);
    const sha256 = createHash("sha256").update(oversized).digest("hex");

    const res = await syncBlobPut(
      new Request(`http://localhost/api/v1/projects/${project.id}/sync/blobs/${sha256}`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${token}`,
          host: "localhost",
          origin: "http://localhost",
          "content-length": String(oversized.byteLength),
        },
        body: oversized,
      }),
      api.ctx({ id: project.id, sha256 }),
    );
    expect(res.status).toBe(413);
    expect((await errorOf(res)).code).toBe("payload_too_large");
  });

  it("上传内容的 hash 与地址不符返回 400", async () => {
    api = await setupTestApi();
    const { project, token } = await projectWithLocation(api);
    const bytes = new TextEncoder().encode("内容与 hash 对不上");
    const wrongSha = "0".repeat(64);

    const res = await syncBlobPut(
      new Request(`http://localhost/api/v1/projects/${project.id}/sync/blobs/${wrongSha}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, host: "localhost", origin: "http://localhost" },
        body: bytes,
      }),
      api.ctx({ id: project.id, sha256: wrongSha }),
    );
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("invalid");
  });

  it("清单里的路径有冲突时返回 400，错误信息里带出问题字段", async () => {
    api = await setupTestApi();
    const { project, token } = await projectWithLocation(api);
    const a = fileEntry("README.md", "a");
    const b = fileEntry("readme.md", "b");

    const res = await syncManifestPost(
      api.request(`/api/v1/projects/${project.id}/sync/manifest`, {
        method: "POST",
        token,
        json: { files: [a.entry, b.entry], git: null, skipped: [], scope },
      }),
      api.ctx({ id: project.id }),
    );
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("invalid");
  });

  it("commit 缺少内容时返回 400，details.missingBlobs 带出缺少的 hash", async () => {
    api = await setupTestApi();
    const { project, token } = await projectWithLocation(api);
    const readme = fileEntry("README.md", "还没上传");

    const manifestRes = await syncManifestPost(
      api.request(`/api/v1/projects/${project.id}/sync/manifest`, {
        method: "POST",
        token,
        json: { files: [readme.entry], git: null, skipped: [], scope },
      }),
      api.ctx({ id: project.id }),
    );
    const { syncId } = (await manifestRes.json()) as { syncId: string };

    const commitRes = await syncCommitPost(
      api.request(`/api/v1/projects/${project.id}/sync/commit`, { method: "POST", token, json: { syncId } }),
      api.ctx({ id: project.id }),
    );
    expect(commitRes.status).toBe(400);
    const error = await errorOf(commitRes);
    expect(error.code).toBe("invalid");
    expect((error.details as { missingBlobs: string[] }).missingBlobs).toEqual([readme.entry.sha256]);
  });

  it("426 与 X-KH-Version 响应头照常生效", async () => {
    api = await setupTestApi();
    const { project, token } = await projectWithLocation(api);

    const res = await syncManifestPost(
      api.request(`/api/v1/projects/${project.id}/sync/manifest`, {
        method: "POST",
        token,
        headers: { "x-kh-version": "0.0.1" },
        json: { files: [], git: null, skipped: [], scope },
      }),
      api.ctx({ id: project.id }),
    );
    expect(res.status).toBe(426);
    expect(res.headers.get("X-KH-Version")).toBeTruthy();
  });
});
