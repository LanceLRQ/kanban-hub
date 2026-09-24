import { afterEach, describe, expect, it } from "vitest";
import { HEADER_KH_AGENT, HEADER_KH_VERSION } from "@kanban-hub/core/api";
import { KhError } from "@kanban-hub/core/errors";
import type { Actor } from "@kanban-hub/core/schema";
import type { Principal } from "../auth/authenticate";
import { setServices } from "../services";
import { apiRoute, type ApiAuthMode, type ApiRouteArgs } from "./route";
import { setupTestApi, type TestApi } from "./testing";

/**
 * 回显鉴权结果，方便断言 principal/actor；GET，不触发同源校验。写成按 auth 模式泛型化的函数，
 * 才能配上 apiRoute 收窄后的 principal/actor 类型——内部按运行时的真实形状转换一次，
 * 不代表调用方也需要这样做：各模式下 apiRoute 传给处理函数的类型已经收窄好了。
 */
function echoHandler<Auth extends ApiAuthMode>({
  principal,
  actor,
}: ApiRouteArgs<Auth, Record<string, never>>): Response {
  const p = principal as unknown as Principal | null;
  const a = actor as unknown as Actor | null;
  return Response.json({ principalKind: p?.kind ?? null, actor: a });
}

function actorOf(res: Response): Promise<Actor | null> {
  return res.json().then((b: { actor: Actor | null }) => b.actor);
}

function errorMessageOf(res: Response): Promise<string> {
  return res.json().then((b: { error: { message: string } }) => b.error.message);
}

describe("apiRoute：版本检查在鉴权之前", () => {
  let api: TestApi;

  afterEach(async () => {
    await api?.cleanup();
  });

  it("没带凭据但版本不兼容时返回 426，而不是 401", async () => {
    api = await setupTestApi();
    const handler = apiRoute({ auth: "session" }, echoHandler);
    const req = api.request("/x", { headers: { [HEADER_KH_VERSION]: "9.9.9" } });
    const res = await handler(req, api.ctx({}));
    expect(res.status).toBe(426);
  });
});

describe("apiRoute：服务容器不存在时返回 503", () => {
  afterEach(() => {
    setServices(undefined);
  });

  it("没有服务容器时返回 503", async () => {
    const handler = apiRoute({ auth: "none" }, echoHandler);
    const req = new Request("http://localhost/x");
    const res = await handler(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(503);
  });
});

describe("apiRoute：鉴权模式与凭据组合", () => {
  let api: TestApi;

  afterEach(async () => {
    await api?.cleanup();
  });

  it("none 模式：无论有没有凭据都放行", async () => {
    api = await setupTestApi();
    const { token } = await api.pairMachine();
    const handler = apiRoute({ auth: "none" }, echoHandler);

    expect((await handler(api.request("/x"), api.ctx({}))).status).toBe(200);
    expect((await handler(api.request("/x", { cookie: api.sessionCookie() }), api.ctx({}))).status).toBe(200);
    expect((await handler(api.request("/x", { token }), api.ctx({}))).status).toBe(200);
  });

  it("session 模式：无凭据 401，会话凭据 200，令牌凭据 403（只能在网页上操作）", async () => {
    api = await setupTestApi();
    const { token } = await api.pairMachine();
    const handler = apiRoute({ auth: "session" }, echoHandler);

    const noCredRes = await handler(api.request("/x"), api.ctx({}));
    expect(noCredRes.status).toBe(401);
    expect(await errorMessageOf(noCredRes)).toContain("重新登录");

    const sessionRes = await handler(api.request("/x", { cookie: api.sessionCookie() }), api.ctx({}));
    expect(sessionRes.status).toBe(200);
    expect((await actorOf(sessionRes))?.via).toBe("web");

    const tokenRes = await handler(api.request("/x", { token }), api.ctx({}));
    expect(tokenRes.status).toBe(403);
    expect(((await tokenRes.json()) as { error: { message: string } }).error.message).toBe("只能在网页上操作");
  });

  it("session 模式：无效的会话 cookie 也是 401，提示重新登录", async () => {
    api = await setupTestApi();
    const handler = apiRoute({ auth: "session" }, echoHandler);
    const res = await handler(api.request("/x", { cookie: "kh_session=not-a-real-session" }), api.ctx({}));
    expect(res.status).toBe(401);
    const message = await errorMessageOf(res);
    expect(message).toContain("重新登录");
    expect(message).not.toContain("kh setup");
    expect(message).not.toContain("kh login");
  });

  it("machine 模式：无凭据 401，令牌凭据 200，会话凭据 403", async () => {
    api = await setupTestApi();
    const { token } = await api.pairMachine();
    const handler = apiRoute({ auth: "machine" }, echoHandler);

    expect((await handler(api.request("/x"), api.ctx({}))).status).toBe(401);

    const tokenRes = await handler(api.request("/x", { token }), api.ctx({}));
    expect(tokenRes.status).toBe(200);
    expect((await actorOf(tokenRes))?.via).toBe("cli");

    const sessionRes = await handler(api.request("/x", { cookie: api.sessionCookie() }), api.ctx({}));
    expect(sessionRes.status).toBe(403);
  });

  it("machine 模式：无效令牌是 401，提示 kh login 重新接入，不提 kh setup", async () => {
    api = await setupTestApi();
    const handler = apiRoute({ auth: "machine" }, echoHandler);
    const res = await handler(api.request("/x", { token: "kh_" + "0".repeat(43) }), api.ctx({}));
    expect(res.status).toBe(401);
    const message = await errorMessageOf(res);
    expect(message).toContain("kh login");
    expect(message).not.toContain("kh setup");
  });

  it("any 模式：会话凭据和令牌凭据都放行，都没有则 401", async () => {
    api = await setupTestApi();
    const { token } = await api.pairMachine();
    const handler = apiRoute({ auth: "any" }, echoHandler);

    expect((await handler(api.request("/x"), api.ctx({}))).status).toBe(401);
    expect((await handler(api.request("/x", { cookie: api.sessionCookie() }), api.ctx({}))).status).toBe(200);
    expect((await handler(api.request("/x", { token }), api.ctx({}))).status).toBe(200);
  });
});

describe("apiRoute：处理函数参数按 auth 模式收窄类型", () => {
  let api: TestApi;

  afterEach(async () => {
    await api?.cleanup();
  });

  it("machine 模式：不用先判 kind 就能读 principal.machine.id 和 actor.userId", async () => {
    api = await setupTestApi();
    const { token, machine } = await api.pairMachine();
    // principal 的类型已经收窄成带 machine 字段的那一支，这里是真正的类型检查：
    // 如果 apiRoute 的类型定义退化回 Principal | null，下面两行会编译不过
    const handler = apiRoute({ auth: "machine" }, ({ principal, actor }) =>
      Response.json({ machineId: principal.machine.id, userId: actor.userId }),
    );
    const res = await handler(api.request("/x", { token }), api.ctx({}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ machineId: machine.id, userId: machine.userId });
  });
});

/**
 * 以下函数只用于 pnpm typecheck 校验类型收窄，不在运行时调用（none 模式下 principal/actor
 * 真的是 null，执行这段代码会抛异常）。用 void 引用一次，避免被当成未使用的声明。
 */
function neverCalled_noneModeArgsAreNull(): void {
  apiRoute({ auth: "none" }, ({ principal, actor }) => {
    // @ts-expect-error none 模式下 principal 恒为 null，不允许直接访问字段
    void principal.kind;
    // @ts-expect-error none 模式下 actor 恒为 null，不允许直接访问字段
    void actor.userId;
    return new Response(null);
  });
}
void neverCalled_noneModeArgsAreNull;

describe("apiRoute：同源校验", () => {
  let api: TestApi;

  afterEach(async () => {
    await api?.cleanup();
  });

  it("会话写请求缺少 Origin 时返回 403", async () => {
    api = await setupTestApi();
    const handler = apiRoute({ auth: "session" }, echoHandler);
    const res = await handler(
      api.request("/x", { method: "POST", cookie: api.sessionCookie(), origin: null }),
      api.ctx({}),
    );
    expect(res.status).toBe(403);
  });

  it("会话写请求 Origin 不同源时返回 403", async () => {
    api = await setupTestApi();
    const handler = apiRoute({ auth: "session" }, echoHandler);
    const res = await handler(
      api.request("/x", { method: "POST", cookie: api.sessionCookie(), origin: "https://evil.example.com" }),
      api.ctx({}),
    );
    expect(res.status).toBe(403);
  });

  it("会话写请求默认同源时放行", async () => {
    api = await setupTestApi();
    const handler = apiRoute({ auth: "session" }, echoHandler);
    const res = await handler(api.request("/x", { method: "POST", cookie: api.sessionCookie() }), api.ctx({}));
    expect(res.status).toBe(200);
  });

  it("会话 GET 请求不做同源校验", async () => {
    api = await setupTestApi();
    const handler = apiRoute({ auth: "session" }, echoHandler);
    const res = await handler(
      api.request("/x", { method: "GET", cookie: api.sessionCookie(), origin: null }),
      api.ctx({}),
    );
    expect(res.status).toBe(200);
  });

  it("令牌请求不带 Origin 也放行", async () => {
    api = await setupTestApi();
    const { token } = await api.pairMachine();
    const handler = apiRoute({ auth: "machine" }, echoHandler);
    const res = await handler(api.request("/x", { method: "POST", token, origin: null }), api.ctx({}));
    expect(res.status).toBe(200);
  });
});

describe("apiRoute：X-KH-Agent", () => {
  let api: TestApi;

  afterEach(async () => {
    await api?.cleanup();
  });

  it("按规则生成 actor.agent：去空白，空串当作没有", async () => {
    api = await setupTestApi();
    const { token } = await api.pairMachine();
    const handler = apiRoute({ auth: "machine" }, echoHandler);

    const withAgent = await handler(
      api.request("/x", { token, headers: { [HEADER_KH_AGENT]: "  claude-code  " } }),
      api.ctx({}),
    );
    expect((await actorOf(withAgent))?.agent).toBe("claude-code");

    const withoutAgent = await handler(api.request("/x", { token }), api.ctx({}));
    expect((await actorOf(withoutAgent))?.agent).toBeNull();

    const blankAgent = await handler(api.request("/x", { token, headers: { [HEADER_KH_AGENT]: "   " } }), api.ctx({}));
    expect((await actorOf(blankAgent))?.agent).toBeNull();
  });

  it("超过 50 个字符时返回 400", async () => {
    api = await setupTestApi();
    const { token } = await api.pairMachine();
    const handler = apiRoute({ auth: "machine" }, echoHandler);
    const res = await handler(
      api.request("/x", { token, headers: { [HEADER_KH_AGENT]: "a".repeat(51) } }),
      api.ctx({}),
    );
    expect(res.status).toBe(400);
  });

  it("会话请求的 actor.agent 恒为 null，哪怕带了 X-KH-Agent", async () => {
    api = await setupTestApi();
    const handler = apiRoute({ auth: "session" }, echoHandler);
    const res = await handler(
      api.request("/x", { cookie: api.sessionCookie(), headers: { [HEADER_KH_AGENT]: "should-be-ignored" } }),
      api.ctx({}),
    );
    expect((await actorOf(res))?.agent).toBeNull();
  });
});

describe("apiRoute：错误映射", () => {
  let api: TestApi;

  afterEach(async () => {
    await api?.cleanup();
  });

  it("处理函数抛出 KhError 时映射成对应的状态码", async () => {
    api = await setupTestApi();
    const handler = apiRoute({ auth: "none" }, () => {
      throw new KhError("not_found", "项目不存在");
    });
    const res = await handler(api.request("/x"), api.ctx({}));
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: { code: string } }).toEqual(
      expect.objectContaining({ error: expect.objectContaining({ code: "not_found" }) }),
    );
  });

  it("正常响应带有 X-KH-Version", async () => {
    api = await setupTestApi();
    const handler = apiRoute({ auth: "none" }, () => new Response(null, { status: 204 }));
    const res = await handler(api.request("/x"), api.ctx({}));
    expect(res.headers.get("X-KH-Version")).not.toBeNull();
  });
});

describe("测试夹具 setupTestApi 冒烟", () => {
  let api: TestApi;

  afterEach(async () => {
    await api?.cleanup();
  });

  it("配对得到的令牌和会话 cookie 都能通过鉴权", async () => {
    api = await setupTestApi();
    const { token } = await api.pairMachine("我的电脑");
    const handler = apiRoute({ auth: "any" }, echoHandler);

    const sessionRes = await handler(api.request("/x", { cookie: api.sessionCookie() }), api.ctx({}));
    expect(sessionRes.status).toBe(200);
    expect((await sessionRes.json()) as { principalKind: string }).toEqual(
      expect.objectContaining({ principalKind: "session" }),
    );

    const tokenRes = await handler(api.request("/x", { token }), api.ctx({}));
    expect(tokenRes.status).toBe(200);
    expect((await tokenRes.json()) as { principalKind: string }).toEqual(
      expect.objectContaining({ principalKind: "machine" }),
    );
  });
});
