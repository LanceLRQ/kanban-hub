import { describe, expect, it, vi } from "vitest";
import { KhError } from "@kanban-hub/core/errors";
import { API_ERROR_CODES, API_ERROR_STATUS, type ApiErrorCode } from "@kanban-hub/core/api";
import { KH_VERSION } from "@kanban-hub/core/version";
import { ApiError, toErrorResponse } from "./errors";

async function body(res: Response): Promise<unknown> {
  return res.json();
}

describe("ApiError", () => {
  it("带有错误码、消息与附加信息", () => {
    const e = new ApiError("forbidden", "禁止访问", { reason: "not_owner" });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("ApiError");
    expect(e.code).toBe("forbidden");
    expect(e.message).toBe("禁止访问");
    expect(e.details).toEqual({ reason: "not_owner" });
  });
});

describe("toErrorResponse：KhError", () => {
  it("invalid → 400，details.issues 原样带出", async () => {
    const res = toErrorResponse(new KhError("invalid", "数据校验失败", { issues: ["a：必填"] }), vi.fn());
    expect(res.status).toBe(400);
    expect(await body(res)).toEqual({ error: { code: "invalid", message: "数据校验失败", details: { issues: ["a：必填"] } } });
  });

  it("not_found → 404", async () => {
    const res = toErrorResponse(new KhError("not_found", "找不到项目"), vi.fn());
    expect(res.status).toBe(404);
    expect(await body(res)).toEqual({ error: { code: "not_found", message: "找不到项目" } });
  });

  it("conflict → 409，details.currentVersion 原样带出", async () => {
    const res = toErrorResponse(new KhError("conflict", "已被更新", { currentVersion: 5 }), vi.fn());
    expect(res.status).toBe(409);
    expect(await body(res)).toEqual({ error: { code: "conflict", message: "已被更新", details: { currentVersion: 5 } } });
  });

  it("unavailable → 503", async () => {
    const res = toErrorResponse(new KhError("unavailable", "服务未就绪"), vi.fn());
    expect(res.status).toBe(503);
    expect(await body(res)).toEqual({ error: { code: "unavailable", message: "服务未就绪" } });
  });
});

describe("toErrorResponse：ApiError", () => {
  it.each(API_ERROR_CODES)("%s 映射到 %s 对应的状态码", async (code) => {
    const res = toErrorResponse(new ApiError(code as ApiErrorCode, "消息"), vi.fn());
    expect(res.status).toBe(API_ERROR_STATUS[code as ApiErrorCode]);
    expect((await body(res) as { error: { code: string } }).error.code).toBe(code);
  });

  it("rate_limited 带 Retry-After 响应头", () => {
    const res = toErrorResponse(new ApiError("rate_limited", "请求太频繁", { retryAfterSeconds: 30 }), vi.fn());
    expect(res.headers.get("Retry-After")).toBe("30");
  });

  it("rate_limited 未指定 retryAfterSeconds 时仍带默认的 Retry-After", () => {
    const res = toErrorResponse(new ApiError("rate_limited", "请求太频繁"), vi.fn());
    expect(res.headers.get("Retry-After")).not.toBeNull();
  });

  it("非 rate_limited 不带 Retry-After", () => {
    const res = toErrorResponse(new ApiError("forbidden", "禁止访问"), vi.fn());
    expect(res.headers.get("Retry-After")).toBeNull();
  });
});

describe("toErrorResponse：其他异常", () => {
  it("普通 Error 返回 500，响应里不含原始消息，只记服务端日志", async () => {
    const log = vi.fn();
    const res = toErrorResponse(new Error("数据库爆炸了，密码是 hunter2"), log);
    expect(res.status).toBe(500);
    const parsed = await body(res);
    expect(parsed).toEqual({ error: { code: "internal", message: "服务端内部错误" } });
    expect(JSON.stringify(parsed)).not.toContain("hunter2");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain("hunter2");
  });

  it("非 Error 的抛出值也归为 500", async () => {
    const log = vi.fn();
    const res = toErrorResponse("字符串错误", log);
    expect(res.status).toBe(500);
    expect(await body(res)).toEqual({ error: { code: "internal", message: "服务端内部错误" } });
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe("响应头", () => {
  it("所有响应都带 X-KH-Version", () => {
    const responses = [
      toErrorResponse(new KhError("not_found", "找不到"), vi.fn()),
      toErrorResponse(new ApiError("forbidden", "禁止访问"), vi.fn()),
      toErrorResponse(new Error("boom"), vi.fn()),
    ];
    for (const res of responses) expect(res.headers.get("X-KH-Version")).toBe(KH_VERSION);
  });
});
