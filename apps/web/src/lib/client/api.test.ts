import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { apiRequest, ApiRequestError } from "./api";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiRequest", () => {
  it("200：按 schema 解析并返回", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { ok: true })));

    const result = await apiRequest("/api/v1/x", { schema: z.object({ ok: z.boolean() }) });
    expect(result).toEqual({ ok: true });
  });

  it("204：没有响应体也不报错", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

    await expect(apiRequest("/api/v1/x", { method: "POST" })).resolves.toBeUndefined();
  });

  it("400：带 issues 的错误信封", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(400, { error: { code: "invalid", message: "数据校验失败", details: { issues: ["标题不能为空"] } } })),
    );

    await expect(apiRequest("/api/v1/x")).rejects.toMatchObject({
      status: 400,
      code: "invalid",
      message: "数据校验失败",
      details: { issues: ["标题不能为空"] },
    } satisfies Partial<ApiRequestError>);
  });

  it("401：未鉴权", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, { error: { code: "unauthorized", message: "密码错误" } })));

    await expect(apiRequest("/api/v1/x")).rejects.toMatchObject({ status: 401, code: "unauthorized", message: "密码错误" });
  });

  it("409：带 currentVersion 的冲突详情", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(409, { error: { code: "conflict", message: "已被更新", details: { currentVersion: 3 } } })),
    );

    await expect(apiRequest("/api/v1/x")).rejects.toMatchObject({
      status: 409,
      code: "conflict",
      details: { currentVersion: 3 },
    });
  });

  it("429：限流详情", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(429, { error: { code: "rate_limited", message: "太频繁", details: { retryAfterSeconds: 12 } } })),
    );

    await expect(apiRequest("/api/v1/x")).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
      details: { retryAfterSeconds: 12 },
    });
  });

  it("500：服务端内部错误", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(500, { error: { code: "internal", message: "服务端内部错误" } })));

    await expect(apiRequest("/api/v1/x")).rejects.toMatchObject({ status: 500, code: "internal" });
  });

  it("非 JSON 响应：解析失败时退化成通用错误", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>502</html>", { status: 502 })));

    const error = (await apiRequest("/api/v1/x").catch((e: unknown) => e)) as ApiRequestError;
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error.status).toBe(502);
    expect(error.code).toBeNull();
  });

  it("网络错误：status 为 0，message 只是内部诊断文本（不面向用户，由调用方翻译展示）", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    const error = (await apiRequest("/api/v1/x").catch((e: unknown) => e)) as ApiRequestError;
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error.status).toBe(0);
    expect(error.code).toBeNull();
  });
});
