import { afterEach, describe, expect, it } from "vitest";
import { setupTestApi, type TestApi } from "@/server/api/testing";
import { POST } from "./route";

describe("POST /api/v1/auth/login", () => {
  let api: TestApi;

  afterEach(async () => {
    await api?.cleanup();
  });

  it("密码正确时返回 200 和用户信息，并签发会话 cookie", async () => {
    api = await setupTestApi();
    const res = await POST(api.request("/api/v1/auth/login", { method: "POST", json: { password: api.adminPassword } }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { id: string; name: string } };
    expect(body.user.name).toBe("admin");

    const cookie = res.headers.get("set-cookie");
    expect(cookie).toContain("kh_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=2592000");
    expect(cookie).not.toContain("Secure");
  });

  it("请求判断为 https（X-Forwarded-Proto）时 cookie 带 Secure", async () => {
    api = await setupTestApi();
    const res = await POST(
      api.request("/api/v1/auth/login", {
        method: "POST",
        json: { password: api.adminPassword },
        headers: { "x-forwarded-proto": "https" },
      }),
    );
    expect(res.headers.get("set-cookie")).toContain("Secure");
  });

  it("密码错误时返回 401", async () => {
    api = await setupTestApi();
    const res = await POST(api.request("/api/v1/auth/login", { method: "POST", json: { password: "not-the-password" } }));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("密码错误");
  });

  it("缺少 Origin 时返回 403", async () => {
    api = await setupTestApi();
    const res = await POST(
      api.request("/api/v1/auth/login", { method: "POST", json: { password: api.adminPassword }, origin: null }),
    );
    expect(res.status).toBe(403);
  });

  it("Origin 不同源时返回 403", async () => {
    api = await setupTestApi();
    const res = await POST(
      api.request("/api/v1/auth/login", {
        method: "POST",
        json: { password: api.adminPassword },
        origin: "https://evil.example.com",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("连续失败 5 次后，第 6 次即使密码正确也返回 429，并带 Retry-After", async () => {
    api = await setupTestApi();
    for (let i = 0; i < 5; i++) {
      const res = await POST(api.request("/api/v1/auth/login", { method: "POST", json: { password: "wrong" } }));
      expect(res.status).toBe(401);
    }
    const res = await POST(api.request("/api/v1/auth/login", { method: "POST", json: { password: api.adminPassword } }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).not.toBeNull();
  });

  it("请求体非法时返回 400，且不计入失败次数", async () => {
    api = await setupTestApi();
    const invalid = await POST(api.request("/api/v1/auth/login", { method: "POST", json: { password: "" } }));
    expect(invalid.status).toBe(400);

    // 不计入失败次数：紧接着还是要连续失败满 5 次才会被限流，不多不少
    for (let i = 0; i < 5; i++) {
      const res = await POST(api.request("/api/v1/auth/login", { method: "POST", json: { password: "wrong" } }));
      expect(res.status).toBe(401);
    }
    const blocked = await POST(
      api.request("/api/v1/auth/login", { method: "POST", json: { password: api.adminPassword } }),
    );
    expect(blocked.status).toBe(429);
  });

  it("并发 10 次错误密码：check 与 recordFailure 之间没有 await，限流恰好拦下超出上限的那部分", async () => {
    api = await setupTestApi();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        POST(api.request("/api/v1/auth/login", { method: "POST", json: { password: "wrong" } })),
      ),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(5);
  });

});
