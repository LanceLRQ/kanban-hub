import { describe, expect, it } from "vitest";
import { z } from "zod";
import { KhError } from "./errors";
import {
  API_ERROR_CODES,
  API_ERROR_STATUS,
  HEADER_KH_AGENT,
  HEADER_KH_VERSION,
  agentNameSchema,
  apiErrorSchema,
  decodeEventCursor,
  encodeEventCursor,
  loginInput,
  machineTokenSchema,
  meResponse,
  pairInput,
  pairResponse,
  parseEventsQuery,
  projectCreatedResponse,
  projectDetailResponse,
  projectListResponse,
  projectViewSchema,
  rateLimitDetailsSchema,
  withExpectedVersion,
} from "./api";

/** 测试用的合法机器令牌：kh_ 加 43 位 [A-Za-z0-9_-] */
const FAKE_TOKEN = `kh_${"a".repeat(43)}`;
import { makeBoard, makeProject } from "./test-fixtures";

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("预期抛出错误");
}

describe("请求头名", () => {
  it("固定为约定的字符串", () => {
    expect(HEADER_KH_VERSION).toBe("x-kh-version");
    expect(HEADER_KH_AGENT).toBe("x-kh-agent");
  });
});

describe("API_ERROR_STATUS", () => {
  it("每个错误码都映射到规格约定的状态码", () => {
    expect(API_ERROR_STATUS).toEqual({
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
    });
    expect(Object.keys(API_ERROR_STATUS).sort()).toEqual([...API_ERROR_CODES].sort());
  });
});

describe("apiErrorSchema", () => {
  it("能解析出合法的错误响应体", () => {
    const body = { error: { code: "conflict", message: "已被更新", details: { currentVersion: 2 } } };
    expect(apiErrorSchema.parse(body)).toEqual(body);
  });

  it("code 不在枚举里时校验失败", () => {
    const r = apiErrorSchema.safeParse({ error: { code: "boom", message: "x" } });
    expect(r.success).toBe(false);
  });

  it("details 可以缺省", () => {
    const body = { error: { code: "not_found", message: "找不到" } };
    expect(apiErrorSchema.parse(body)).toEqual(body);
  });
});

describe("pairInput", () => {
  it("接受合法的配对请求体", () => {
    expect(pairInput.parse({ code: "ABC-DEF", machineName: "my-mac", os: "darwin" })).toEqual({
      code: "ABC-DEF",
      machineName: "my-mac",
      os: "darwin",
    });
  });

  it("缺少字段时校验失败", () => {
    expect(pairInput.safeParse({ code: "ABC-DEF", machineName: "my-mac" }).success).toBe(false);
  });

  it("os 不在枚举里时校验失败", () => {
    expect(pairInput.safeParse({ code: "ABC-DEF", machineName: "my-mac", os: "amiga" }).success).toBe(false);
  });

  it("拒绝未知字段（strict）", () => {
    expect(pairInput.safeParse({ code: "ABC-DEF", machineName: "my-mac", os: "darwin", extra: 1 }).success).toBe(
      false,
    );
  });
});

describe("loginInput", () => {
  it("接受合法的登录请求体", () => {
    expect(loginInput.parse({ password: "hunter2" })).toEqual({ password: "hunter2" });
  });

  it("密码为空时校验失败", () => {
    expect(loginInput.safeParse({ password: "" }).success).toBe(false);
  });

  it("拒绝未知字段（strict）", () => {
    expect(loginInput.safeParse({ password: "hunter2", extra: 1 }).success).toBe(false);
  });
});

describe("withExpectedVersion", () => {
  const patchInput = z.object({ title: z.string() }).strict();
  const schema = withExpectedVersion(patchInput);

  it("把请求体拆成 patch 与 expectedVersion", () => {
    expect(schema.parse({ title: "新标题", version: 3 })).toEqual({
      patch: { title: "新标题" },
      expectedVersion: 3,
    });
  });

  it("不带 version 时 expectedVersion 为 undefined", () => {
    expect(schema.parse({ title: "新标题" })).toEqual({
      patch: { title: "新标题" },
      expectedVersion: undefined,
    });
  });

  it("version 不是正整数时校验失败", () => {
    expect(schema.safeParse({ title: "新标题", version: 0 }).success).toBe(false);
    expect(schema.safeParse({ title: "新标题", version: 1.5 }).success).toBe(false);
  });

  it("保留原 schema 的 strict 行为", () => {
    expect(schema.safeParse({ title: "新标题", extra: 1 }).success).toBe(false);
  });
});

describe("事件游标", () => {
  it("能来回编解码", () => {
    const cursor = { ts: "2026-09-24T10:00:00.000Z", id: "k3v9x2m7qa" };
    expect(decodeEventCursor(encodeEventCursor(cursor))).toEqual(cursor);
  });

  it("非法游标（没有分隔符）报 invalid", () => {
    const err = thrown(() => decodeEventCursor("不是游标"));
    expect(err).toBeInstanceOf(KhError);
    expect((err as KhError).code).toBe("invalid");
  });

  it("非法游标（时间戳格式不对）报 invalid", () => {
    const err = thrown(() => decodeEventCursor("不是时间戳_k3v9x2m7qa"));
    expect(err).toBeInstanceOf(KhError);
    expect((err as KhError).code).toBe("invalid");
  });

  it("非法游标（id 格式不对）报 invalid", () => {
    const err = thrown(() => decodeEventCursor("2026-09-24T10:00:00.000Z_太短"));
    expect(err).toBeInstanceOf(KhError);
    expect((err as KhError).code).toBe("invalid");
  });
});

describe("rateLimitDetailsSchema", () => {
  it("能解析 pair、login 实际返回的 429 details", () => {
    expect(rateLimitDetailsSchema.parse({ retryAfterSeconds: 30 })).toEqual({ retryAfterSeconds: 30 });
  });

  it("retryAfterSeconds 缺失或类型不对时校验失败", () => {
    expect(rateLimitDetailsSchema.safeParse({}).success).toBe(false);
    expect(rateLimitDetailsSchema.safeParse({ retryAfterSeconds: "30" }).success).toBe(false);
  });
});

describe("pairResponse", () => {
  it("能解析配对成功的响应体", () => {
    const body = { token: FAKE_TOKEN, machineId: "m000000001" };
    expect(pairResponse.parse(body)).toEqual(body);
  });

  it("令牌格式不对时校验失败", () => {
    expect(pairResponse.safeParse({ token: "not-a-token", machineId: "m000000001" }).success).toBe(false);
  });
});

describe("agentNameSchema", () => {
  it("接受 1-50 个可打印 ASCII 字符", () => {
    expect(agentNameSchema.safeParse("claude-code").success).toBe(true);
    expect(agentNameSchema.safeParse("a".repeat(50)).success).toBe(true);
  });

  it("拒绝空字符串", () => {
    expect(agentNameSchema.safeParse("").success).toBe(false);
  });

  it("拒绝包含空格的值", () => {
    expect(agentNameSchema.safeParse("claude code").success).toBe(false);
  });

  it("拒绝中文", () => {
    expect(agentNameSchema.safeParse("验收脚本").success).toBe(false);
  });

  it("拒绝控制字符", () => {
    expect(agentNameSchema.safeParse("a\nb").success).toBe(false);
    expect(agentNameSchema.safeParse("a\tb").success).toBe(false);
  });

  it("拒绝超过 50 个字符", () => {
    expect(agentNameSchema.safeParse("a".repeat(51)).success).toBe(false);
  });
});

describe("machineTokenSchema", () => {
  it("接受 kh_ 加 43 位 base64url 字符", () => {
    expect(machineTokenSchema.safeParse(FAKE_TOKEN).success).toBe(true);
  });

  it("拒绝缺少前缀或长度不对的值", () => {
    expect(machineTokenSchema.safeParse("abc").success).toBe(false);
    expect(machineTokenSchema.safeParse(`kh_${"a".repeat(42)}`).success).toBe(false);
    expect(machineTokenSchema.safeParse(`kh_${"a".repeat(44)}`).success).toBe(false);
  });

  it("拒绝含非法字符（例如换行、空格）", () => {
    expect(machineTokenSchema.safeParse(`kh_${"a".repeat(42)}\n`).success).toBe(false);
    expect(machineTokenSchema.safeParse(`kh_ ${"a".repeat(42)}`).success).toBe(false);
  });
});

describe("meResponse", () => {
  it("能解析会话请求的响应体（machine 为 null）", () => {
    const body = { user: { id: "u000000001", name: "admin", role: "admin" as const }, machine: null, serverVersion: "0.1.0" };
    expect(meResponse.parse(body)).toEqual(body);
  });

  it("能解析令牌请求的响应体（带 machine）", () => {
    const body = {
      user: { id: "u000000001", name: "admin", role: "admin" as const },
      machine: { id: "m000000001", name: "我的电脑", os: "darwin" as const },
      serverVersion: "0.1.0",
    };
    expect(meResponse.parse(body)).toEqual(body);
  });
});

describe("projectViewSchema / projectListResponse / projectDetailResponse / projectCreatedResponse", () => {
  const project = makeProject();
  const board = makeBoard();

  it("projectViewSchema 能解析项目视图（project、lastEventAt、stale）", () => {
    const view = { project, lastEventAt: null, stale: false };
    expect(projectViewSchema.parse(view)).toEqual(view);
  });

  it("projectListResponse 能解析项目列表响应", () => {
    const body = { projects: [{ project, lastEventAt: "2026-09-24T10:00:00.000Z", stale: true }] };
    expect(projectListResponse.parse(body)).toEqual(body);
  });

  it("projectDetailResponse 是 ProjectView 加 board", () => {
    const body = { project, lastEventAt: null, stale: false, board };
    expect(projectDetailResponse.parse(body)).toEqual(body);
  });

  it("projectCreatedResponse 能解析新建项目的响应体", () => {
    const body = { project, board };
    expect(projectCreatedResponse.parse(body)).toEqual(body);
  });
});

describe("parseEventsQuery", () => {
  it("没有 limit 时取默认值 50", () => {
    expect(parseEventsQuery(new URLSearchParams())).toEqual({ projectId: undefined, before: undefined, limit: 50 });
  });

  it("limit 低于下限时报 invalid", () => {
    expect(thrown(() => parseEventsQuery(new URLSearchParams({ limit: "0" })))).toBeInstanceOf(KhError);
    expect((thrown(() => parseEventsQuery(new URLSearchParams({ limit: "-5" }))) as KhError).code).toBe("invalid");
  });

  it("limit 高于上限时报 invalid", () => {
    const err = thrown(() => parseEventsQuery(new URLSearchParams({ limit: "500" })));
    expect(err).toBeInstanceOf(KhError);
    expect((err as KhError).code).toBe("invalid");
  });

  it("limit 不是整数时报 invalid", () => {
    expect((thrown(() => parseEventsQuery(new URLSearchParams({ limit: "abc" }))) as KhError).code).toBe("invalid");
    expect((thrown(() => parseEventsQuery(new URLSearchParams({ limit: "1.5" }))) as KhError).code).toBe("invalid");
  });

  it("用 project 传项目 ID 能解析出 projectId", () => {
    expect(parseEventsQuery(new URLSearchParams({ project: "p0000000aa" })).projectId).toBe("p0000000aa");
  });

  it("传 projectId= 不会被当作项目筛选（查询参数名是 project）", () => {
    expect(parseEventsQuery(new URLSearchParams({ projectId: "p0000000aa" })).projectId).toBeUndefined();
  });

  it("project 为空串时当作没传", () => {
    expect(parseEventsQuery(new URLSearchParams({ project: "" })).projectId).toBeUndefined();
  });

  it("before 是合法游标时解码出来", () => {
    const q = parseEventsQuery(new URLSearchParams({ before: "2026-09-24T10:00:00.000Z_k3v9x2m7qa" }));
    expect(q.before).toEqual({ ts: "2026-09-24T10:00:00.000Z", id: "k3v9x2m7qa" });
  });

  it("before 格式不对时报 invalid", () => {
    const err = thrown(() => parseEventsQuery(new URLSearchParams({ before: "不是游标" })));
    expect(err).toBeInstanceOf(KhError);
    expect((err as KhError).code).toBe("invalid");
  });
});
