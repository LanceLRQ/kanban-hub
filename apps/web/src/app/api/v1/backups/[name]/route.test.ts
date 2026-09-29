import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { setupTestApi, type TestApi } from "@/server/api/testing";
import { POST } from "../route";
import { GET } from "./route";

describe("GET /api/v1/backups/:name", () => {
  let api: TestApi;

  afterEach(async () => {
    await api?.cleanup();
  });

  async function createBackup(): Promise<string> {
    const res = await POST(
      api.request("/api/v1/backups", { method: "POST", cookie: api.sessionCookie(), json: {} }),
    );
    expect(res.status).toBe(201);
    return ((await res.json()) as { fileName: string }).fileName;
  }

  function download(name: string, opts: { cookie?: string | null; token?: string } = {}) {
    return GET(
      api.request(`/api/v1/backups/${encodeURIComponent(name)}`, {
        cookie: opts.cookie !== undefined ? opts.cookie : api.sessionCookie(),
        token: opts.token,
      }),
      api.ctx({ name }),
    );
  }

  it("下载的响应头与字节都正确", async () => {
    api = await setupTestApi();
    const fileName = await createBackup();

    const res = await download(fileName);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="${fileName}"`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = new Uint8Array(await res.arrayBuffer());
    const onDisk = await fs.readFile(path.join(api.backupDir, fileName));
    expect(Buffer.from(body).equals(onDisk)).toBe(true);
  });

  it("404：名字合法但文件不存在", async () => {
    api = await setupTestApi();
    expect((await download("kanban-hub-20200101-000000.zip")).status).toBe(404);
  });

  it("404：名字不匹配约定正则的一律拦下（穿越、绝对路径、非 zip 名）", async () => {
    api = await setupTestApi();
    // 路由处理函数拿到的 params 已经解码，URL 里的 ..%2F 到这里就是 ../
    const badNames = [
      "../escape.zip",
      "/abs/kanban-hub-20260929-120000.zip",
      "kanban-hub-20260929-120000.zip.txt",
      "kanban-hub-20260929-120000",
    ];
    for (const name of badNames) {
      expect((await download(name)).status, name).toBe(404);
    }
  });

  it("机器令牌也能下载", async () => {
    api = await setupTestApi();
    const fileName = await createBackup();
    const { token } = await api.pairMachine();
    expect((await download(fileName, { token, cookie: null })).status).toBe(200);
  });
});
