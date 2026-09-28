import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { SyncManifestInput } from "@kanban-hub/core/api";
import type { Actor } from "@kanban-hub/core/schema";
import type { IncomingFile } from "@kanban-hub/core/sync";
import { setupTestApi, type TestApi } from "@/server/api/testing";
import { rawTokenSecret, signRawToken } from "@/server/auth/raw-token";
import { GET } from "./route";

const prepActor: Actor = { userId: "0000000000", machineId: null, via: "web", agent: null };

function sha(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function incoming(p: string, content: Uint8Array): IncomingFile {
  return { path: p, sha256: sha(content), size: content.length, mtime: 1_700_000_000_000, base: null };
}

const SCOPE = { include: ["**"], exclude: [], maxFileSize: 1024 * 1024 };
const GIT_STATE = { branch: "main", head: "a".repeat(40), headSubject: "初始", headAt: "2026-09-23T09:00:00.000Z", dirtyCount: 0, ahead: null, behind: null };

async function setupProject(api: TestApi) {
  const { project } = await api.store.createProject({ name: "测试项目" }, prepActor);
  const { machine } = await api.pairMachine("mac");
  await api.store.setLocation(project.id, machine.id, { path: "/repo" }, prepActor);
  return { project, machine };
}

async function sync(api: TestApi, projectId: string, machineId: string, files: Record<string, Uint8Array>): Promise<void> {
  const entries = Object.entries(files).map(([p, c]) => incoming(p, c));
  const input: SyncManifestInput = { files: entries, git: GIT_STATE, skipped: [], scope: SCOPE };
  const begun = await api.store.beginSync(projectId, machineId, input);
  const byHash = new Map(entries.map((e) => [e.sha256, files[e.path]!]));
  for (const hash of begun.missing) await api.store.putSyncBlob(projectId, machineId, hash, byHash.get(hash)!);
  const admin = api.store.auth.listUsers().find((u) => u.role === "admin")!;
  await api.store.commitSync(projectId, machineId, begun.syncId, { userId: admin.id, machineId, via: "cli", agent: null });
}

function token(api: TestApi, projectId: string, machineId: string, now: Date): string {
  const secret = rawTokenSecret(api.store.auth.sessionSecret());
  return signRawToken(secret, { projectId, machineId }, now).token;
}

async function get(url: string, opts: { headers?: Record<string, string> } = {}) {
  const parts = url.split("/").filter((s) => s !== "");
  // /raw/:token/*path
  const [, tokenSeg, ...path] = parts;
  const req = new Request(`http://localhost${url}`, { headers: opts.headers });
  return GET(req, { params: Promise.resolve({ token: tokenSeg!, path }) });
}

describe("GET /raw/:token/*path", () => {
  let api: TestApi;

  afterEach(async () => {
    await api?.cleanup();
  });

  it("正确令牌返回原始字节", async () => {
    api = await setupTestApi();
    const { project, machine } = await setupProject(api);
    const content = Buffer.from("hello world");
    await sync(api, project.id, machine.id, { "a.txt": content });

    const tok = token(api, project.id, machine.id, api.services.now());
    const res = await get(`/raw/${tok}/a.txt`);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(content));
  });

  it("html、svg、png、css、未知扩展名的 Content-Type 正确", async () => {
    api = await setupTestApi();
    const { project, machine } = await setupProject(api);
    const files = {
      "a.html": Buffer.from("<h1>x</h1>"),
      "a.svg": Buffer.from("<svg></svg>"),
      "a.png": Buffer.from([137, 80, 78, 71]),
      "a.css": Buffer.from("body{}"),
      "a.weird": Buffer.from("??"),
    };
    await sync(api, project.id, machine.id, files);
    const tok = token(api, project.id, machine.id, api.services.now());

    expect((await get(`/raw/${tok}/a.html`)).headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect((await get(`/raw/${tok}/a.svg`)).headers.get("content-type")).toBe("image/svg+xml");
    expect((await get(`/raw/${tok}/a.png`)).headers.get("content-type")).toBe("image/png");
    expect((await get(`/raw/${tok}/a.weird`)).headers.get("content-type")).toBe("application/octet-stream");
  });

  it("每个响应都带 nosniff、沙箱 CSP、Referrer-Policy", async () => {
    api = await setupTestApi();
    const { project, machine } = await setupProject(api);
    await sync(api, project.id, machine.id, { "a.txt": Buffer.from("x") });
    const tok = token(api, project.id, machine.id, api.services.now());

    const res = await get(`/raw/${tok}/a.txt`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("sandbox allow-scripts allow-forms allow-popups");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("令牌错误返回 404", async () => {
    api = await setupTestApi();
    const res = await get("/raw/not-a-real-token/a.txt");
    expect(res.status).toBe(404);
  });

  it("令牌过期返回 403，正文是纯文本提示刷新文档页，沙箱响应头照旧", async () => {
    api = await setupTestApi();
    const { project, machine } = await setupProject(api);
    await sync(api, project.id, machine.id, { "a.txt": Buffer.from("x") });
    const past = new Date(api.services.now().getTime() - 13 * 60 * 60 * 1000);
    const tok = token(api, project.id, machine.id, past);

    const res = await get(`/raw/${tok}/a.txt`);
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toBe("链接已过期，请刷新文档页");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("sandbox allow-scripts allow-forms allow-popups");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("路径穿越和不在清单里的路径返回 404", async () => {
    api = await setupTestApi();
    const { project, machine } = await setupProject(api);
    await sync(api, project.id, machine.id, { "a.txt": Buffer.from("x") });
    const tok = token(api, project.id, machine.id, api.services.now());

    expect((await GET(new Request("http://localhost/raw/x"), { params: Promise.resolve({ token: tok, path: ["..", "..", "auth", "users.yaml"] }) })).status).toBe(404);
    expect((await get(`/raw/${tok}/not-in-manifest.txt`)).status).toBe(404);
  });

  it("请求带不带 cookie，结果都一样", async () => {
    api = await setupTestApi();
    const { project, machine } = await setupProject(api);
    await sync(api, project.id, machine.id, { "a.txt": Buffer.from("x") });
    const tok = token(api, project.id, machine.id, api.services.now());

    const withCookie = await get(`/raw/${tok}/a.txt`, { headers: { cookie: api.sessionCookie() } });
    const withoutCookie = await get(`/raw/${tok}/a.txt`);
    expect(withCookie.status).toBe(withoutCookie.status);
    expect(await withCookie.text()).toBe(await withoutCookie.text());
  });
});
