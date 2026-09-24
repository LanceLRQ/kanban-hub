import { afterEach, describe, expect, it } from "vitest";
import { setupTestApi, type TestApi } from "@/server/api/testing";
import { POST } from "./route";

describe("POST /api/v1/auth/logout", () => {
  let api: TestApi;

  afterEach(async () => {
    await api?.cleanup();
  });

  it("返回 204 并清除会话 cookie", async () => {
    api = await setupTestApi();
    const res = await POST(api.request("/api/v1/auth/logout", { method: "POST", cookie: api.sessionCookie() }));

    expect(res.status).toBe(204);
    const cookie = res.headers.get("set-cookie");
    expect(cookie).toContain("kh_session=");
    expect(cookie).toContain("Max-Age=0");
  });

  it("缺少 Origin 时返回 403", async () => {
    api = await setupTestApi();
    const res = await POST(api.request("/api/v1/auth/logout", { method: "POST", cookie: api.sessionCookie(), origin: null }));
    expect(res.status).toBe(403);
  });

  it("没有会话 cookie 也能登出（none 鉴权，只清除 cookie）", async () => {
    api = await setupTestApi();
    const res = await POST(api.request("/api/v1/auth/logout", { method: "POST" }));
    expect(res.status).toBe(204);
  });
});
