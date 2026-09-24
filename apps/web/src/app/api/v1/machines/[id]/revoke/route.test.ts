import { afterEach, describe, expect, it } from "vitest";
import { hashPassword } from "@/server/auth/password";
import { setupTestApi, type TestApi } from "@/server/api/testing";
import { GET as ME } from "../../../me/route";
import { POST } from "./route";

describe("POST /api/v1/machines/:id/revoke", () => {
  let api: TestApi;

  afterEach(async () => {
    await api?.cleanup();
  });

  it("吊销后返回机器信息（不含 tokenHash），该机器的令牌不能再访问 /me", async () => {
    api = await setupTestApi();
    const { token, machine } = await api.pairMachine("机器 A");

    const res = await POST(
      api.request(`/api/v1/machines/${machine.id}/revoke`, { method: "POST", cookie: api.sessionCookie() }),
      api.ctx({ id: machine.id }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; revokedAt: string | null };
    expect(body.id).toBe(machine.id);
    expect(body.revokedAt).not.toBeNull();
    expect(body).not.toHaveProperty("tokenHash");

    const meRes = await ME(api.request("/api/v1/me", { token }));
    expect(meRes.status).toBe(401);
  });

  it("重复吊销返回 200，不报错", async () => {
    api = await setupTestApi();
    const { machine } = await api.pairMachine();
    const cookie = api.sessionCookie();

    const first = await POST(
      api.request(`/api/v1/machines/${machine.id}/revoke`, { method: "POST", cookie }),
      api.ctx({ id: machine.id }),
    );
    expect(first.status).toBe(200);

    const second = await POST(
      api.request(`/api/v1/machines/${machine.id}/revoke`, { method: "POST", cookie }),
      api.ctx({ id: machine.id }),
    );
    expect(second.status).toBe(200);
  });

  it("机器不存在返回 404", async () => {
    api = await setupTestApi();
    const res = await POST(
      api.request("/api/v1/machines/no-such-id/revoke", { method: "POST", cookie: api.sessionCookie() }),
      api.ctx({ id: "no-such-id" }),
    );
    expect(res.status).toBe(404);
  });

  it("别人的机器按不存在处理，返回 404", async () => {
    api = await setupTestApi();
    const otherUser = await api.store.auth.createUser({
      name: "另一个人",
      role: "member",
      passwordHash: await hashPassword("无所谓"),
    });
    const othersMachine = await api.store.auth.createMachine({
      name: "别人的机器",
      userId: otherUser.id,
      os: "linux",
      tokenHash: "0".repeat(64),
    });

    const res = await POST(
      api.request(`/api/v1/machines/${othersMachine.id}/revoke`, { method: "POST", cookie: api.sessionCookie() }),
      api.ctx({ id: othersMachine.id }),
    );
    expect(res.status).toBe(404);
  });
});
