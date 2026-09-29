import { afterEach, describe, expect, it } from "vitest";
import { setupTestApi, type TestApi } from "@/server/api/testing";
import { GET } from "./route";

let api: TestApi;

afterEach(async () => {
  await api.cleanup();
});

function get(headers: Record<string, string>): Promise<Response> {
  return Promise.resolve(GET(new Request("http://internal/setup/agent.md", { headers })));
}

describe("GET /setup/agent.md", () => {
  it("不带 cookie 返回 200，三个响应头齐全", async () => {
    api = await setupTestApi();
    const res = await get({ host: "kanban.example.com" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("配置了 publicUrl 时用它，不理会请求头", async () => {
    api = await setupTestApi();
    api.services.publicUrl = "https://kanban.example.com";
    const body = await (await get({ host: "other:1", "x-forwarded-host": "evil.com" })).text();
    expect(body).toContain("npm i -g https://kanban.example.com/setup/kh.tgz");
    expect(body).not.toContain("evil.com");
  });

  it("没配置时按 Host 推断，带 X-Forwarded-Host 时优先用它", async () => {
    api = await setupTestApi();
    const byHost = await (await get({ host: "192.168.1.20:28970" })).text();
    expect(byHost).toContain("http://192.168.1.20:28970/setup/kh.tgz");
    const byForwarded = await (
      await get({ host: "internal:28970", "x-forwarded-host": "kanban.example.com", "x-forwarded-proto": "https" })
    ).text();
    expect(byForwarded).toContain("https://kanban.example.com/setup/kh.tgz");
  });

  it.each(["evil.com/x", "a@b"])("Host 是 %s 时用占位符并要求先问用户地址", async (host) => {
    api = await setupTestApi();
    const body = await (await get({ host })).text();
    expect(body).toContain("<服务端地址>/setup/kh.tgz");
    expect(body).toContain("向用户询问服务端地址");
    expect(body).not.toContain(host);
  });

  it("依次给出接入所需的各条命令，地址已填入", async () => {
    api = await setupTestApi();
    const body = await (await get({ host: "kanban.example.com" })).text();
    const order = [
      "node --version",
      "npm i -g http://kanban.example.com/setup/kh.tgz",
      "kh --version",
      "http://kanban.example.com/api/health",
      "kh login --server http://kanban.example.com --code <配对码>",
      "kh setup --dry-run",
      "kh setup --yes",
      "http://kanban.example.com/setup/migrate.md",
    ];
    let from = 0;
    for (const piece of order) {
      const at = body.indexOf(piece, from);
      expect(at, piece).toBeGreaterThanOrEqual(from);
      from = at;
    }
    expect(body).toContain("sudo");
    expect(body).toContain("原样告诉用户");
  });
});
