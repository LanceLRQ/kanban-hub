import { z } from "zod";
import { KhError } from "./errors";
import { idSchema } from "./ids";
import {
  boardSchema,
  eventTypeSchema,
  gitStateSchema,
  machineOsSchema,
  projectSchema,
  snapshotPathSchema,
  syncScopeSchema,
  timestampSchema,
  userRoleSchema,
  type EventType,
} from "./schema";
import { findManifestPathProblem, incomingFileSchema, manifestFileSchema, sha256HexSchema, SYNC_MAX_MANIFEST_FILES } from "./sync";

// ---------- 网页与 kh 共用的请求头 ----------

/** kh 上报自己的版本，服务端用它做 426 检查 */
export const HEADER_KH_VERSION = "x-kh-version";
/** kh 用它标识自己，具体校验和使用由鉴权模块负责 */
export const HEADER_KH_AGENT = "x-kh-agent";
/** 快照文件内容的响应头，值是文件内容的 sha256，供 kh 校验下载是否完整 */
export const HEADER_KH_SHA256 = "X-KH-Sha256";

/**
 * agent 名称的合法字符集：1-50 个可打印 ASCII 字符（0x21-0x7E），不含空格。
 * 收紧到 ASCII 是因为 agent 名称最终会进入 HTTP 请求头：超出这个范围的字符（包括退格、
 * 换行等控制字符，以及非 ASCII 字符）在请求头里要么无法发送，要么会被服务端 trim 掉，
 * 导致 kh 发出的值和服务端记录的值不一致。kh 和服务端共用这一份规则。
 */
export const agentNameSchema = z
  .string()
  .regex(/^[\x21-\x7E]{1,50}$/, "必须是 1-50 个可打印 ASCII 字符，不能包含空格");

/**
 * 机器令牌的格式：kh_ 加 43 位 base64url 字符（与服务端签发的格式一致，见
 * apps/web/src/server/auth/token.ts）。kh 和服务端共用这一份规则，避免格式校验出现分歧。
 */
export const machineTokenSchema = z.string().regex(/^kh_[A-Za-z0-9_-]{43}$/, "不是合法的机器令牌格式");

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

// ---------- 响应 schema（网页与 kh 共用的契约） ----------

/** 429 的 details：还要等多少秒才能重试 */
export const rateLimitDetailsSchema = z.object({
  retryAfterSeconds: z.number(),
});
export type RateLimitDetails = z.infer<typeof rateLimitDetailsSchema>;

export const pairResponse = z.object({
  token: machineTokenSchema,
  machineId: idSchema,
});
export type PairResponse = z.infer<typeof pairResponse>;

export const meResponse = z.object({
  user: z.object({ id: idSchema, name: z.string(), role: userRoleSchema }),
  machine: z.object({ id: idSchema, name: z.string(), os: machineOsSchema }).nullable(),
  serverVersion: z.string(),
});
export type MeResponse = z.infer<typeof meResponse>;

/** 项目列表和详情接口共用：项目本体、最近一次事件时间（停滞判定用）、停滞标记（规格 5.5） */
export const projectViewSchema = z.object({
  project: projectSchema,
  lastEventAt: timestampSchema.nullable(),
  stale: z.boolean(),
});
export type ProjectView = z.infer<typeof projectViewSchema>;

export const projectListResponse = z.object({
  projects: z.array(projectViewSchema),
});
export type ProjectListResponse = z.infer<typeof projectListResponse>;

export const projectDetailResponse = projectViewSchema.extend({
  board: boardSchema,
});
export type ProjectDetailResponse = z.infer<typeof projectDetailResponse>;

export const projectCreatedResponse = z.object({
  project: projectSchema,
  board: boardSchema,
});
export type ProjectCreatedResponse = z.infer<typeof projectCreatedResponse>;

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
  types?: EventType[];
  /** "web" 或某台机器的 ID */
  actor?: "web" | string;
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
 * 解析逗号分隔的事件类型列表；重复项去重（保留首次出现的顺序），空串或缺省当作没传。
 * 其中一项不是合法的事件类型时抛 KhError("invalid")，错误信息里写出是哪一项。
 */
function parseTypes(raw: string | null): EventType[] | undefined {
  if (raw === null || raw.trim() === "") return undefined;
  const seen = new Set<EventType>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const parsed = eventTypeSchema.safeParse(trimmed);
    if (!parsed.success) throw new KhError("invalid", `不是合法的事件类型：${trimmed}`);
    seen.add(parsed.data);
  }
  return seen.size > 0 ? [...seen] : undefined;
}

/** actor 只接受 "web" 或合法的机器 ID（idSchema），空串或缺省当作没传 */
function parseActor(raw: string | null): string | undefined {
  if (raw === null || raw.trim() === "") return undefined;
  if (raw === "web") return "web";
  if (!idSchema.safeParse(raw).success) throw new KhError("invalid", `actor 必须是 web 或合法的机器 ID（收到：${raw}）`);
  return raw;
}

/**
 * 解析 GET /events 的查询参数（规格 11 节：project、before、limit、types、actor）。
 * 项目筛选的查询参数名是 project（不是 projectId），返回字段沿用 projectId，供路由传给 Store。
 * limit 缺省时取默认值，不是整数或越界时抛 KhError("invalid")；before、types、actor 格式不对同样抛 invalid。
 */
export function parseEventsQuery(searchParams: URLSearchParams): EventsQuery {
  const beforeRaw = searchParams.get("before");
  return {
    projectId: orUndefinedIfBlank(searchParams.get("project")),
    before: beforeRaw ? decodeEventCursor(beforeRaw) : undefined,
    limit: parseLimit(searchParams.get("limit")),
    types: parseTypes(searchParams.get("types")),
    actor: parseActor(searchParams.get("actor")),
  };
}


// ---------- 文档同步（规格第 9、11 节） ----------

/** POST /projects/:id/sync/manifest 的请求体 */
export const syncManifestInput = z
  .object({
    files: z
      .array(incomingFileSchema)
      .max(SYNC_MAX_MANIFEST_FILES, `一份清单最多 ${SYNC_MAX_MANIFEST_FILES} 个文件`)
      .superRefine((files, ctx) => {
        const problem = findManifestPathProblem(files.map((f) => f.path));
        if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
      }),
    git: gitStateSchema.nullable(),
    skipped: z.array(z.object({ path: snapshotPathSchema, size: z.number().int().min(0) })),
    scope: syncScopeSchema,
  })
  .strict();
export type SyncManifestInput = z.input<typeof syncManifestInput>;

export const syncManifestResponse = z.object({
  syncId: z.string(),
  missing: z.array(sha256HexSchema),
  expiresAt: timestampSchema,
});
export type SyncManifestResponse = z.infer<typeof syncManifestResponse>;

/** POST /projects/:id/sync/commit 的请求体 */
export const syncCommitInput = z.object({ syncId: z.string() }).strict();
export type SyncCommitInput = z.input<typeof syncCommitInput>;

export const syncCommitResponse = z.object({
  added: z.number().int().min(0),
  modified: z.number().int().min(0),
  removed: z.number().int().min(0),
  unchanged: z.number().int().min(0),
  lastSyncAt: timestampSchema,
});
export type SyncCommitResponse = z.infer<typeof syncCommitResponse>;

/** GET /projects/:id/snapshots/:machineId/manifest 的响应 */
export const snapshotManifestResponse = z.object({
  machineId: idSchema,
  machineName: z.string(),
  lastSyncAt: timestampSchema.nullable(),
  files: z.array(manifestFileSchema),
});
export type SnapshotManifestResponse = z.infer<typeof snapshotManifestResponse>;

/** GET /projects/:id/snapshots/latest-manifest 的响应 */
export const latestManifestResponse = z.object({
  files: z.array(manifestFileSchema.extend({ machineId: idSchema })),
  machines: z.array(z.object({ id: idSchema, name: z.string(), lastSyncAt: timestampSchema.nullable() })),
});
export type LatestManifestResponse = z.infer<typeof latestManifestResponse>;

/**
 * POST /projects/:id/sync/pulled 的请求体：kh 拉取完成后上报结果，服务端据此记 docs.pulled
 * 事件。至少一项计数大于 0 才需要上报，全为 0 时没有必要调用这个接口。
 */
export const pullReportInput = z
  .object({
    created: z.number().int().min(0),
    overwritten: z.number().int().min(0),
    merged: z.number().int().min(0),
    conflicts: z.number().int().min(0),
    stale: z.number().int().min(0),
    /** 取用了内容的来源机器；一个项目的机器数远小于这个上限，只防止单条事件写入过多 ID */
    fromMachineIds: z.array(idSchema).max(100),
  })
  .strict()
  .superRefine((counts, ctx) => {
    const total = counts.created + counts.overwritten + counts.merged + counts.conflicts + counts.stale;
    if (total === 0) ctx.addIssue({ code: "custom", message: "至少要有一项计数大于 0" });
  });
export type PullReportInput = z.input<typeof pullReportInput>;

/** commit 因为缺少内容而返回 400 时，details 的形状；kh 用它识别“缺少内容”这种失败原因 */
export const syncMissingDetails = z.object({ missingBlobs: z.array(sha256HexSchema) });
export type SyncMissingDetails = z.infer<typeof syncMissingDetails>;

/** POST /projects/:id/raw-tokens 的请求体：网页为某台机器签一个 /raw 令牌 */
export const rawTokenInput = z.object({ machineId: idSchema }).strict();
export type RawTokenInput = z.input<typeof rawTokenInput>;

/** POST /projects/:id/raw-tokens 的响应 */
export const rawTokenResponse = z.object({ token: z.string(), expiresAt: timestampSchema });
export type RawTokenResponse = z.infer<typeof rawTokenResponse>;
