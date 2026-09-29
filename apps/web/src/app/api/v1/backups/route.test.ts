import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { setupTestApi, type TestApi } from "@/server/api/testing";
import { GET, POST } from "./route";

/** 组一个带默认会话的创建请求；json 传 undefined 表示不带请求体 */
function createReq(api: TestApi, json?: unknown, opts: { cookie?: string | null; token?: string } = {}) {
  return api.request("/api/v1/backups", {
    method: "POST",
    json,
    cookie: opts.cookie !== undefined ? opts.cookie : api.sessionCookie(),
    token: opts.token,
  });
}

describe("POST /api/v1/backups", () => {
  let api: TestApi;

  afterEach(async () => {
    vi.restoreAllMocks();
    await api?.cleanup();
  });

  it("创建后返回 201，响应体与落盘文件一致，且不泄露密码", async () => {
    api = await setupTestApi();
    const res = await POST(createReq(api, { password: "秘密密码", includeGit: false }));

    expect(res.status).toBe(201);
    const body = (await res.json()) as { fileName: string; size: number; createdAt: string };
    expect(body.fileName).toMatch(/^kanban-hub-\d{8}-\d{6}\.zip$/);
    // 响应完成即文件就绪：备份目录里正好是这一份
    expect(await fs.readdir(api.backupDir)).toEqual([body.fileName]);
    const st = await fs.stat(path.join(api.backupDir, body.fileName));
    expect(st.size).toBe(body.size);
    // 响应体只有这三个字段：密码只用于打包，明文不回显
    expect(Object.keys(body).sort()).toEqual(["createdAt", "fileName", "size"]);
    expect(JSON.stringify(body)).not.toContain("秘密密码");
  });

  it("不带请求体按默认值创建（不加密、含历史）", async () => {
    api = await setupTestApi();
    expect((await POST(createReq(api))).status).toBe(201);
  });

  it("已有备份在进行中时返回 409，不排队新备份", async () => {
    api = await setupTestApi();
    vi.spyOn(api.store, "backupRunning").mockReturnValue(true);

    expect((await POST(createReq(api, {}))).status).toBe(409);
    expect(await fs.readdir(api.backupDir).catch(() => [])).toEqual([]);
  });

  it("400：密码超长、includeGit 非布尔、未知字段都不创建", async () => {
    api = await setupTestApi();

    expect((await POST(createReq(api, { password: "a".repeat(129) }))).status).toBe(400);
    expect((await POST(createReq(api, { includeGit: "yes" }))).status).toBe(400);
    expect((await POST(createReq(api, { extra: 1 }))).status).toBe(400);
    expect(await fs.readdir(api.backupDir).catch(() => [])).toEqual([]);
  });

  it("401：无凭据；网页会话与机器令牌都可以创建", async () => {
    api = await setupTestApi();

    expect((await POST(api.request("/api/v1/backups", { method: "POST", json: {} }))).status).toBe(401);
    expect((await POST(createReq(api, {}))).status).toBe(201);
    const { token } = await api.pairMachine();
    expect((await POST(createReq(api, {}, { token, cookie: null }))).status).toBe(201);
  });
});

describe("GET /api/v1/backups", () => {
  let api: TestApi;

  afterEach(async () => {
    await api?.cleanup();
  });

  async function createOne(): Promise<string> {
    const res = await POST(createReq(api, {}));
    expect(res.status).toBe(201);
    return ((await res.json()) as { fileName: string }).fileName;
  }

  it("列表按创建时间倒序，条目只含文件名、大小和创建时间", async () => {
    api = await setupTestApi();
    const first = await createOne();
    const second = await createOne();
    expect(first).not.toBe(second);
    // 把先创建的改成更旧的修改时间：排序按时间，不按文件名
    const older = new Date(Date.now() - 60_000);
    await fs.utimes(path.join(api.backupDir, first), older, older);

    const res = await GET(api.request("/api/v1/backups", { cookie: api.sessionCookie() }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { backups: Array<{ fileName: string; size: number; createdAt: string }> };
    expect(body.backups.map((b) => b.fileName)).toEqual([second, first]);
    for (const b of body.backups) {
      expect(Object.keys(b).sort()).toEqual(["createdAt", "fileName", "size"]);
    }
  });

  it("401：无凭据", async () => {
    api = await setupTestApi();
    expect((await GET(api.request("/api/v1/backups"))).status).toBe(401);
  });
});
