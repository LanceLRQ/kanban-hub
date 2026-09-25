import { afterEach, describe, expect, it, vi } from "vitest";
import { pairResponse, rateLimitDetailsSchema } from "@kanban-hub/core/api";
import { PairingRegistry } from "@/server/auth/pairing";
import { setupTestApi, type TestApi } from "@/server/api/testing";
import { GET as ME } from "../me/route";
import { POST as LOGIN } from "../auth/login/route";
import { POST } from "./route";

describe("POST /api/v1/pair", () => {
  let api: TestApi;

  afterEach(async () => {
    await api?.cleanup();
  });

  it("完整流程：拿到的令牌能访问 /me，machine 字段正确", async () => {
    api = await setupTestApi();
    const admin = api.store.auth.listUsers().find((u) => u.role === "admin")!;
    const { code } = api.services.pairing.issue(admin.id);

    const res = await POST(
      api.request("/api/v1/pair", {
        method: "POST",
        origin: null,
        json: { code, machineName: "我的笔记本", os: "darwin" },
      }),
    );
    expect(res.status).toBe(201);
    const body = pairResponse.parse(await res.json());
    expect(body.token).toMatch(/^kh_/);

    const meRes = await ME(api.request("/api/v1/me", { token: body.token }));
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as { machine: { id: string; name: string; os: string } | null };
    expect(me.machine).toEqual({ id: body.machineId, name: "我的笔记本", os: "darwin" });
  });

  it("同一个配对码用第二次返回 401", async () => {
    api = await setupTestApi();
    const admin = api.store.auth.listUsers().find((u) => u.role === "admin")!;
    const { code } = api.services.pairing.issue(admin.id);
    const payload = { code, machineName: "机器 A", os: "darwin" as const };

    const first = await POST(api.request("/api/v1/pair", { method: "POST", origin: null, json: payload }));
    expect(first.status).toBe(201);

    const second = await POST(api.request("/api/v1/pair", { method: "POST", origin: null, json: payload }));
    expect(second.status).toBe(401);
  });

  it("过期的配对码返回 401", async () => {
    api = await setupTestApi();
    let fakeNow = new Date("2026-09-24T00:00:00.000Z");
    api.services.pairing = new PairingRegistry({ now: () => fakeNow, ttlMs: 60_000 });

    const admin = api.store.auth.listUsers().find((u) => u.role === "admin")!;
    const { code } = api.services.pairing.issue(admin.id);
    fakeNow = new Date(fakeNow.getTime() + 60_001);

    const res = await POST(
      api.request("/api/v1/pair", { method: "POST", origin: null, json: { code, machineName: "机器 A", os: "darwin" } }),
    );
    expect(res.status).toBe(401);
  });

  it("同一 IP 连续失败 5 次后返回 429", async () => {
    api = await setupTestApi();
    for (let i = 0; i < 5; i++) {
      const res = await POST(
        api.request("/api/v1/pair", {
          method: "POST",
          origin: null,
          json: { code: "XXX-XXX", machineName: "机器 A", os: "darwin" },
        }),
      );
      expect(res.status).toBe(401);
    }
    const res = await POST(
      api.request("/api/v1/pair", {
        method: "POST",
        origin: null,
        json: { code: "XXX-XXX", machineName: "机器 A", os: "darwin" },
      }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).not.toBeNull();
    const error = ((await res.json()) as { error: { details?: unknown } }).error;
    expect(rateLimitDetailsSchema.parse(error.details).retryAfterSeconds).toBeGreaterThan(0);
  });

  it("请求体非法时返回 400", async () => {
    api = await setupTestApi();
    const res = await POST(api.request("/api/v1/pair", { method: "POST", origin: null, json: { code: "" } }));
    expect(res.status).toBe(400);
  });

  it("并发 10 次错误配对码：check 与 recordFailure 之间没有 await，限流恰好拦下超出上限的那部分", async () => {
    api = await setupTestApi();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        POST(
          api.request("/api/v1/pair", {
            method: "POST",
            origin: null,
            json: { code: "XXX-XXX", machineName: "机器 A", os: "darwin" },
          }),
        ),
      ),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(5);
  });

  it("同一个 IP 配对失败 5 次后，登录仍然可以成功（限流键按接口区分前缀）", async () => {
    api = await setupTestApi();
    for (let i = 0; i < 5; i++) {
      const res = await POST(
        api.request("/api/v1/pair", {
          method: "POST",
          origin: null,
          json: { code: "XXX-XXX", machineName: "机器 A", os: "darwin" },
        }),
      );
      expect(res.status).toBe(401);
    }
    const blocked = await POST(
      api.request("/api/v1/pair", {
        method: "POST",
        origin: null,
        json: { code: "XXX-XXX", machineName: "机器 A", os: "darwin" },
      }),
    );
    expect(blocked.status).toBe(429);

    const loginRes = await LOGIN(
      api.request("/api/v1/auth/login", { method: "POST", json: { password: api.adminPassword } }),
    );
    expect(loginRes.status).toBe(200);
  });

  it("创建机器失败后，配对码仍然可以用", async () => {
    api = await setupTestApi();
    const admin = api.store.auth.listUsers().find((u) => u.role === "admin")!;
    const { code } = api.services.pairing.issue(admin.id);
    const payload = { code, machineName: "机器 A", os: "darwin" as const };

    vi.spyOn(api.store.auth, "createMachine").mockRejectedValueOnce(new Error("模拟写入失败"));

    const failed = await POST(api.request("/api/v1/pair", { method: "POST", origin: null, json: payload }));
    expect(failed.status).toBe(500);

    const retried = await POST(api.request("/api/v1/pair", { method: "POST", origin: null, json: payload }));
    expect(retried.status).toBe(201);
  });
});
