import { afterEach, describe, expect, it } from "vitest";
import { setupTestApi, type TestApi } from "@/server/api/testing";
import { POST } from "./route";

describe("POST /api/v1/pairing-codes", () => {
  let api: TestApi;

  afterEach(async () => {
    await api?.cleanup();
  });

  it("没有凭据时返回 401", async () => {
    api = await setupTestApi();
    const res = await POST(api.request("/api/v1/pairing-codes", { method: "POST" }));
    expect(res.status).toBe(401);
  });

  it("令牌请求返回 403", async () => {
    api = await setupTestApi();
    const { token } = await api.pairMachine();
    const res = await POST(api.request("/api/v1/pairing-codes", { method: "POST", token }));
    expect(res.status).toBe(403);
  });

  it("用会话请求成功，返回 201 和配对码", async () => {
    api = await setupTestApi();
    const res = await POST(api.request("/api/v1/pairing-codes", { method: "POST", cookie: api.sessionCookie() }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { code: string; expiresAt: string };
    expect(body.code).toMatch(/^[A-Z0-9]{3}-[A-Z0-9]{3}$/);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });
});
