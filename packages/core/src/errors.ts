import type { z } from "zod";

export type KhErrorCode = "invalid" | "not_found" | "conflict" | "unavailable";

/**
 * 存储层与 API 共用的业务错误。M2 按 code 映射 HTTP 状态码：
 * invalid → 400，not_found → 404，conflict → 409，unavailable → 503。
 */
export class KhError extends Error {
  constructor(
    readonly code: KhErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "KhError";
  }
}

/** 字段路径写成 tasks[0].title 的形式 */
export function formatPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") out += `[${seg}]`;
    else out += out === "" ? String(seg) : `.${String(seg)}`;
  }
  return out;
}

/** 把 zod 的错误整理成“字段路径：原因”的列表 */
export function formatZodError(error: z.ZodError): string[] {
  return error.issues.map((issue) =>
    issue.path.length > 0 ? `${formatPath(issue.path)}：${issue.message}` : issue.message,
  );
}

/** 按 schema 校验输入，失败时抛出 invalid 错误 */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issues = formatZodError(result.error);
    throw new KhError("invalid", `数据校验失败：${issues.join("；")}`, { issues });
  }
  return result.data;
}
