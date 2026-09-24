import { afterEach, describe, expect, it } from "vitest";
import { KH_VERSION } from "@kanban-hub/core/version";
import { setupTestApi, type TestApi } from "@/server/api/testing";
import { GET } from "./route";

describe("GET /api/v1/me", () => {
  let api: TestApi;

  afterEach(async () => {
    await api?.cleanup();
  });

  it("会话请求时返回用户信息，machine 为 null", async () => {
    api = await setupTestApi();
    const res = await GET(api.request("/api/v1/me", { cookie: api.sessionCookie() }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { id: string; name: string; role: string }; machine: unknown; serverVersion: string };
    expect(body.user.name).toBe("admin");
    expect(body.user.role).toBe("admin");
    expect(body.machine).toBeNull();
    expect(body.serverVersion).toBe(KH_VERSION);
  });

  it("令牌请求时带上本机信息", async () => {
    api = await setupTestApi();
    const { token, machine } = await api.pairMachine("我的电脑");
    const res = await GET(api.request("/api/v1/me", { token }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { machine: { id: string; name: string; os: string } | null };
    expect(body.machine).toEqual({ id: machine.id, name: "我的电脑", os: machine.os });
  });

  it("响应里没有 passwordHash", async () => {
    api = await setupTestApi();
    const res = await GET(api.request("/api/v1/me", { cookie: api.sessionCookie() }));
    const text = await res.text();
    expect(text).not.toContain("passwordHash");
  });

  it("没有凭据时返回 401", async () => {
    api = await setupTestApi();
    const res = await GET(api.request("/api/v1/me"));
    expect(res.status).toBe(401);
  });
});
