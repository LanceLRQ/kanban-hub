import { z } from "zod";
import { KhError } from "./errors";
import { idSchema } from "./ids";
import { machineOsSchema, timestampSchema } from "./schema";

// ---------- 网页与 kh 共用的请求头 ----------

/** kh 上报自己的版本，服务端用它做 426 检查 */
export const HEADER_KH_VERSION = "x-kh-version";
/** kh 用它标识自己，具体校验和使用由鉴权模块负责 */
export const HEADER_KH_AGENT = "x-kh-agent";

// ---------- 错误响应（规格 15 节） ----------

export const API_ERROR_CODES = [
  "invalid",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "payload_too_large",
  "upgrade_required",
  "rate_limited",
  "internal",
  "unavailable",
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** 错误码对应的 HTTP 状态码，网页外壳与 kh 共用同一份 */
export const API_ERROR_STATUS: Record<ApiErrorCode, number> = {
  invalid: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  upgrade_required: 426,
  rate_limited: 429,
  internal: 500,
  unavailable: 503,
};

/** 错误响应体的形状：{ error: { code, message, details? } }，kh 用它解析失败响应 */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.enum(API_ERROR_CODES),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;

// ---------- 输入 schema ----------

export const pairInput = z
  .object({
    code: z.string().trim().min(1),
    machineName: z.string().trim().min(1).max(100),
    os: machineOsSchema,
  })
  .strict();
export type PairInput = z.input<typeof pairInput>;

export const loginInput = z
  .object({
    password: z.string().min(1),
  })
  .strict();
export type LoginInput = z.input<typeof loginInput>;

/**
 * 给修改类输入 schema 加上可选的 version 字段（乐观并发控制），
 * 解析结果拆成 { patch, expectedVersion }，原 schema 的 strict 行为保留。
 */
export function withExpectedVersion<S extends z.ZodObject<z.ZodRawShape>>(
  schema: S,
): z.ZodType<{ patch: z.output<S>; expectedVersion: number | undefined }> {
  // S 是泛型形状，extend() 的静态类型推不出精确的字段类型，这里按运行时的实际形状断言
  const extended = schema.extend({ version: z.number().int().min(1).optional() }) as unknown as z.ZodType<
    z.output<S> & { version?: number }
  >;
  return extended.transform(({ version, ...rest }) => ({ patch: rest as z.output<S>, expectedVersion: version }));
}

// ---------- 事件游标与查询参数 ----------

export interface EventCursor {
  ts: string;
  id: string;
}

const eventCursorFields = z.object({ ts: timestampSchema, id: idSchema });

/** 写成 <ts>_<id>，例如 2026-09-24T10:00:00.000Z_k3v9x2m7qa */
export function encodeEventCursor(cursor: EventCursor): string {
  return `${cursor.ts}_${cursor.id}`;
}

export function decodeEventCursor(raw: string): EventCursor {
  const sep = raw.lastIndexOf("_");
  const result = sep < 0 ? null : eventCursorFields.safeParse({ ts: raw.slice(0, sep), id: raw.slice(sep + 1) });
  if (!result || !result.success) throw new KhError("invalid", `事件游标格式不对：${raw}`);
  return result.data;
}

const EVENTS_LIMIT_DEFAULT = 50;
const EVENTS_LIMIT_MIN = 1;
const EVENTS_LIMIT_MAX = 200;

export interface EventsQuery {
  projectId?: string;
  before?: EventCursor;
  limit: number;
}

function parseLimit(raw: string | null): number {
  if (raw === null || raw.trim() === "") return EVENTS_LIMIT_DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < EVENTS_LIMIT_MIN || n > EVENTS_LIMIT_MAX) {
    throw new KhError("invalid", `limit 必须是 ${EVENTS_LIMIT_MIN} 到 ${EVENTS_LIMIT_MAX} 之间的整数（收到：${raw}）`);
  }
  return n;
}

function orUndefinedIfBlank(raw: string | null): string | undefined {
  return raw === null || raw.trim() === "" ? undefined : raw;
}

/**
 * 解析 GET /events 的查询参数（规格 11 节：project、before、limit）。
 * 项目筛选的查询参数名是 project（不是 projectId），返回字段沿用 projectId，供路由传给 Store。
 * limit 缺省时取默认值，不是整数或越界时抛 KhError("invalid")；before 格式不对同样抛 invalid。
 */
export function parseEventsQuery(searchParams: URLSearchParams): EventsQuery {
  const beforeRaw = searchParams.get("before");
  return {
    projectId: orUndefinedIfBlank(searchParams.get("project")),
    before: beforeRaw ? decodeEventCursor(beforeRaw) : undefined,
    limit: parseLimit(searchParams.get("limit")),
  };
}
