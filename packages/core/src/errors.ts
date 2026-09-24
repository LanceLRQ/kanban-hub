import type { z } from "zod";

export type KhErrorCode = "invalid" | "not_found" | "conflict" | "unavailable";

/**
 * 跨模块实例识别用的品牌标记。Turbopack 把同一份源码在 instrumentation 和 app-route
 * 两个上下文里编译成不同的模块实例：Store 在 instrumentation 一侧创建，它抛出的 KhError
 * 和路由那一侧 import 到的 KhError 不是同一个类对象，`instanceof` 会失败。Symbol.for
 * 用的是引擎全局的 symbol 注册表，两个模块实例拿到的是同一个 symbol，可以跨实例识别。
 */
const KH_ERROR_BRAND = Symbol.for("kanban-hub.KhError");

/**
 * 存储层与 API 共用的业务错误。M2 按 code 映射 HTTP 状态码：
 * invalid → 400，not_found → 404，conflict → 409，unavailable → 503。
 */
export class KhError extends Error {
  readonly [KH_ERROR_BRAND] = true;

  constructor(
    readonly code: KhErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "KhError";
  }
}

/** 判断是否为 KhError：先 instanceof，跨模块实例时退化到品牌标记 */
export function isKhError(e: unknown): e is KhError {
  if (e instanceof KhError) return true;
  return typeof e === "object" && e !== null && (e as Record<PropertyKey, unknown>)[KH_ERROR_BRAND] === true;
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
