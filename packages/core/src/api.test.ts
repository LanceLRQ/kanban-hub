import { describe, expect, it } from "vitest";
import { z } from "zod";
import { KhError } from "./errors";
import {
  API_ERROR_CODES,
  API_ERROR_STATUS,
  HEADER_KH_AGENT,
  HEADER_KH_VERSION,
  apiErrorSchema,
  decodeEventCursor,
  encodeEventCursor,
  loginInput,
  pairInput,
  parseEventsQuery,
  withExpectedVersion,
} from "./api";

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
