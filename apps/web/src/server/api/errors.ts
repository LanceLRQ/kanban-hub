import { API_ERROR_STATUS, type ApiErrorCode } from "@kanban-hub/core/api";
import { KhError } from "@kanban-hub/core/errors";
import { KH_VERSION } from "@kanban-hub/core/version";

/** API 层的业务错误：鉴权、限流、版本不兼容等 KhError 覆盖不到的场景 */
export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const DEFAULT_RETRY_AFTER_SECONDS = 60;

function retryAfterSeconds(details: unknown): number {
  if (details && typeof details === "object" && "retryAfterSeconds" in details) {
    const v = (details as { retryAfterSeconds?: unknown }).retryAfterSeconds;
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  }
  return DEFAULT_RETRY_AFTER_SECONDS;
}

function errorResponse(code: ApiErrorCode, message: string, details?: unknown): Response {
  const headers = new Headers({ "X-KH-Version": KH_VERSION });
  // 429 提示客户端多久之后可以重试；没带具体秒数时给一个默认值
  if (code === "rate_limited") headers.set("Retry-After", String(retryAfterSeconds(details)));

  const error: { code: ApiErrorCode; message: string; details?: unknown } = { code, message };
  if (details !== undefined) error.details = details;
  return Response.json({ error }, { status: API_ERROR_STATUS[code], headers });
}

/**
 * 把 KhError、ApiError 和其他任何异常统一映射成 API 错误响应。
 * 不是这两种业务错误的异常一律当作服务端内部错误：原始信息只交给 log，不回显给客户端。
 */
export function toErrorResponse(e: unknown, log: (message: string) => void): Response {
  if (e instanceof KhError) return errorResponse(e.code, e.message, e.details);
  if (e instanceof ApiError) return errorResponse(e.code, e.message, e.details);

  log(e instanceof Error ? (e.stack ?? e.message) : String(e));
  return errorResponse("internal", "服务端内部错误");
}
