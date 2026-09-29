import { afterEach, describe, expect, it } from "vitest";
import { hashPassword } from "@/server/auth/password";
import { setupTestApi, type TestApi } from "@/server/api/testing";
import { PATCH } from "./route";

describe("PATCH /api/v1/machines/:id", () => {
  let api: TestApi;

  afterEach(async () => {
    await api?.cleanup();
  });

  function rename(id: string, json: unknown, cookie: string | undefined = api.sessionCookie()) {
    return PATCH(api.request(`/api/v1/machines/${id}`, { method: "PATCH", cookie, json }), api.ctx({ id }));
  }

  it("改名后返回机器信息（不含 tokenHash），名称去掉首尾空白并写入存储", async () => {
    api = await setupTestApi();
    const { machine } = await api.pairMachine("机器 A");

    const res = await rename(machine.id, { name: "  书房的 Mac  " });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; name: string };
    expect(body).toMatchObject({ id: machine.id, name: "书房的 Mac" });
    expect(body).not.toHaveProperty("tokenHash");
    expect(api.store.auth.getMachine(machine.id)?.name).toBe("书房的 Mac");
  });

  it("名称为空或超长返回 400，名称不变", async () => {
    api = await setupTestApi();
    const { machine } = await api.pairMachine("机器 A");

    expect((await rename(machine.id, { name: " " })).status).toBe(400);
    expect((await rename(machine.id, { name: "a".repeat(101) })).status).toBe(400);
    expect(api.store.auth.getMachine(machine.id)?.name).toBe("机器 A");
  });

  it("已吊销的机器不能改名，返回 409", async () => {
    api = await setupTestApi();
    const { machine } = await api.pairMachine("机器 A");
    await api.store.auth.updateMachine(machine.id, { revokedAt: new Date().toISOString() });

    expect((await rename(machine.id, { name: "新名字" })).status).toBe(409);
    expect(api.store.auth.getMachine(machine.id)?.name).toBe("机器 A");
  });

  it("机器不存在或属于别人时返回 404", async () => {
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

    expect((await rename("no-such-id", { name: "x" })).status).toBe(404);
    expect((await rename(othersMachine.id, { name: "x" })).status).toBe(404);
    expect(api.store.auth.getMachine(othersMachine.id)?.name).toBe("别人的机器");
  });

  it("用机器令牌调用返回 403（只接受网页会话）", async () => {
    api = await setupTestApi();
    const { token, machine } = await api.pairMachine("机器 A");

    const res = await PATCH(
      api.request(`/api/v1/machines/${machine.id}`, { method: "PATCH", token, json: { name: "x" } }),
      api.ctx({ id: machine.id }),
    );
    expect(res.status).toBe(403);
  });
});
