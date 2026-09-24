import { afterEach, describe, expect, it } from "vitest";
import { hashPassword } from "@/server/auth/password";
import { setupTestApi, type TestApi } from "@/server/api/testing";
import { GET } from "./route";

describe("GET /api/v1/machines", () => {
  let api: TestApi;

  afterEach(async () => {
    await api?.cleanup();
  });

  it("列表按创建时间升序排列，且不含 tokenHash", async () => {
    api = await setupTestApi();
    const first = await api.pairMachine("机器 A");
    const second = await api.pairMachine("机器 B");

    const res = await GET(api.request("/api/v1/machines", { cookie: api.sessionCookie() }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { machines: { id: string; name: string }[] };
    expect(body.machines.map((m) => m.id)).toEqual([first.machine.id, second.machine.id]);
    for (const m of body.machines) expect(m).not.toHaveProperty("tokenHash");
  });

  it("只返回当前用户自己的机器", async () => {
    api = await setupTestApi();
    const mine = await api.pairMachine("我的机器");

    const otherUser = await api.store.auth.createUser({
      name: "另一个人",
      role: "member",
      passwordHash: await hashPassword("无所谓"),
    });
    await api.store.auth.createMachine({
      name: "别人的机器",
      userId: otherUser.id,
      os: "linux",
      tokenHash: "0".repeat(64),
    });

    const res = await GET(api.request("/api/v1/machines", { cookie: api.sessionCookie() }));
    const body = (await res.json()) as { machines: { id: string }[] };
    expect(body.machines.map((m) => m.id)).toEqual([mine.machine.id]);
  });

  it("没有凭据时返回 401，令牌请求返回 403", async () => {
    api = await setupTestApi();
    const { token } = await api.pairMachine();

    expect((await GET(api.request("/api/v1/machines"))).status).toBe(401);
    expect((await GET(api.request("/api/v1/machines", { token }))).status).toBe(403);
  });
});
