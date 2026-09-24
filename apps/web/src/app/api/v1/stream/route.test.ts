import { afterEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@kanban-hub/core/schema";
import { setupTestApi, type TestApi } from "@/server/api/testing";
import { GET } from "./route";

/** 与 route.ts 里的心跳间隔保持一致 */
const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * 从 SSE 流里读取字节，解码累积到 buffer，直到出现 match 或超时。
 * 每次 read() 都套一个超时，避免流一直不来数据时测试挂死。
 */
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, match: string, timeoutMs = 2000): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  while (!buffer.includes(match)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`等待 SSE 内容超时：${match}`);
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("读取 SSE 流超时")), remaining)),
    ]);
    if (result.done) throw new Error(`SSE 流已经关闭，等不到：${match}`);
    buffer += decoder.decode(result.value, { stream: true });
  }
  return buffer;
}

/** 等流关闭（reader.read() 返回 done），带超时避免挂死 */
async function expectClosed(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs = 2000): Promise<void> {
  const result = await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("等待流关闭超时")), timeoutMs)),
  ]);
  expect(result.done).toBe(true);
}

async function machineActor(api: TestApi): Promise<Actor> {
  const { machine } = await api.pairMachine();
  return { userId: machine.userId, machineId: machine.id, via: "cli", agent: null };
}

describe("GET /api/v1/stream", () => {
  let api: TestApi;

  afterEach(async () => {
    vi.useRealTimers();
    await api?.cleanup();
  });

  it("令牌请求返回 403，没有凭据返回 401", async () => {
    api = await setupTestApi();
    const { token } = await api.pairMachine();

    const tokenRes = await GET(api.request("/api/v1/stream", { token }));
    expect(tokenRes.status).toBe(403);

    const noCredRes = await GET(api.request("/api/v1/stream"));
    expect(noCredRes.status).toBe(401);
  });

  it("响应头正确，且先收到 ready", async () => {
    api = await setupTestApi();
    const res = await GET(api.request("/api/v1/stream", { cookie: api.sessionCookie() }));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("no-cache, no-transform");
    expect(res.headers.get("X-Accel-Buffering")).toBe("no");

    const reader = res.body!.getReader();
    const text = await readUntil(reader, "event: ready");
    expect(text).toContain("retry: 3000");
    await reader.cancel();
  });

  it("触发一次存储写入后，收到 change", async () => {
    api = await setupTestApi();
    const actor = await machineActor(api);
    const res = await GET(api.request("/api/v1/stream", { cookie: api.sessionCookie() }));
    const reader = res.body!.getReader();
    await readUntil(reader, "event: ready");

    const { project } = await api.store.createProject({ name: "看板" }, actor);

    const text = await readUntil(reader, "event: change");
    expect(text).toContain(`"projectId":"${project.id}"`);
    await reader.cancel();
  });

  it("中止请求后，取消订阅被调用", async () => {
    api = await setupTestApi();
    const unsubscribeSpy = vi.fn();
    const originalSubscribe = api.store.subscribe.bind(api.store);
    vi.spyOn(api.store, "subscribe").mockImplementation((listener) => {
      const unsubscribeOriginal = originalSubscribe(listener);
      return () => {
        unsubscribeSpy();
        unsubscribeOriginal();
      };
    });

    const controller = new AbortController();
    const req = new Request(api.request("/api/v1/stream", { cookie: api.sessionCookie() }), { signal: controller.signal });
    const res = await GET(req);
    const reader = res.body!.getReader();
    await readUntil(reader, "event: ready");

    controller.abort();

    expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
  });

  it("假定时器推进到心跳：会话有效时收到心跳；sessionVersion 变了之后流被关闭", async () => {
    api = await setupTestApi();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

    const res = await GET(api.request("/api/v1/stream", { cookie: api.sessionCookie() }));
    const reader = res.body!.getReader();
    await readUntil(reader, "event: ready");

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    const heartbeatText = await readUntil(reader, ": heartbeat");
    expect(heartbeatText).toContain(": heartbeat");

    const admin = api.store.auth.listUsers().find((u) => u.role === "admin")!;
    await api.store.auth.updateUser(admin.id, { sessionVersion: admin.sessionVersion + 1 });

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    await expectClosed(reader);
  });

  it("心跳重新鉴权意外抛错时按会话失效处理：关闭流、取消订阅，且不产生未处理的 rejection", async () => {
    api = await setupTestApi();

    const unsubscribeSpy = vi.fn();
    const originalSubscribe = api.store.subscribe.bind(api.store);
    vi.spyOn(api.store, "subscribe").mockImplementation((listener) => {
      const unsubscribeOriginal = originalSubscribe(listener);
      return () => {
        unsubscribeSpy();
        unsubscribeOriginal();
      };
    });

    // 心跳的 void heartbeat() 一旦有未捕获的异常就会变成未处理的 rejection：
    // 用真实的 process 事件断言这次修复确实兜住了，而不是只看流关闭这个表面现象
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

      const res = await GET(api.request("/api/v1/stream", { cookie: api.sessionCookie() }));
      const reader = res.body!.getReader();
      await readUntil(reader, "event: ready");

      // 模拟存储层一个没预料到的 bug：重新鉴权路径上的 getUser 直接抛错，不是"会话失效"这种预期分支
      vi.spyOn(api.store.auth, "getUser").mockImplementation(() => {
        throw new Error("模拟存储层意外错误");
      });

      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
      await expectClosed(reader);
      expect(unsubscribeSpy).toHaveBeenCalledTimes(1);

      // 用真实定时器让事件循环走一轮，未处理的 rejection 会在这里被 process 事件报出来
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandledRejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });
});
