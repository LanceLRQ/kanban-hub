import { describe, expect, it } from "vitest";
import { z } from "zod";
import { KhError, formatPath, formatZodError, parseInput } from "./errors";

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("预期抛出错误");
}

describe("formatPath", () => {
  it("数组下标写成 [n]，字段之间用点连接", () => {
    expect(formatPath(["tasks", 0, "title"])).toBe("tasks[0].title");
    expect(formatPath([2, "n"])).toBe("[2].n");
    expect(formatPath([])).toBe("");
  });
});

describe("formatZodError", () => {
  it("每个问题一行：字段路径：原因", () => {
    const r = z.object({ tasks: z.array(z.object({ title: z.string() })) }).safeParse({ tasks: [{ title: 1 }] });
    expect(r.success).toBe(false);
    expect(formatZodError(r.error!)).toEqual([expect.stringMatching(/^tasks\[0\]\.title：.+/)]);
  });

  it("没有字段路径时只有原因", () => {
    const r = z.string().safeParse(1);
    expect(formatZodError(r.error!)).toEqual([r.error!.issues[0]!.message]);
  });
});

describe("parseInput", () => {
  const schema = z.object({ a: z.string() });

  it("校验通过时返回解析结果", () => {
    expect(parseInput(schema, { a: "x", extra: 1 })).toEqual({ a: "x" });
  });

  it("校验失败时抛出 invalid，details 里是逐条原因", () => {
    const err = thrown(() => parseInput(schema, {}));
    expect(err).toBeInstanceOf(KhError);
    expect((err as KhError).code).toBe("invalid");
    expect((err as KhError).details).toEqual({ issues: [expect.stringMatching(/^a：/)] });
    expect((err as KhError).message).toMatch(/^数据校验失败：a：/);
  });
});

describe("KhError", () => {
  it("带有错误类别与附加信息，name 为 KhError", () => {
    const e = new KhError("conflict", "已被更新", { currentVersion: 2 });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("KhError");
    expect(e.code).toBe("conflict");
    expect(e.details).toEqual({ currentVersion: 2 });
  });
});
