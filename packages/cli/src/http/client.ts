import type { z } from "zod";
import {
  apiErrorSchema,
  rateLimitDetailsSchema,
  HEADER_KH_AGENT,
  HEADER_KH_VERSION,
  type ApiErrorBody,
} from "@kanban-hub/core/api";
import { KH_VERSION } from "@kanban-hub/core/version";
import { CliError, EXIT } from "../errors";

const DEFAULT_TIMEOUT_MS = 15_000;

export interface ApiClientOptions {
  /** 服务端地址，不带末尾的 / */
  server: string;
  token?: string;
  agent?: string | null;
  fetch: typeof fetch;
  /** 默认 15000ms */
  timeoutMs?: number;
}

function issueLines(details: unknown): string[] {
  if (details && typeof details === "object" && "issues" in details) {
    const issues = (details as { issues?: unknown }).issues;
    if (Array.isArray(issues)) return issues.filter((i): i is string => typeof i === "string");
  }
  return [];
}

function upgradeHint(server: string): string {
  return `执行 npm i -g ${server}/setup/kh.tgz 更新 kh`;
}

/** 404/405 但响应不是错误格式：说明服务端根本没有这个接口，多半是 kh 与服务端版本不一致 */
function missingEndpointError(server: string): CliError {
  return new CliError(EXIT.INCOMPATIBLE, "服务端没有这个接口，kh 与服务端版本可能不一致", upgradeHint(server));
}

/** 按“退出码的归属”把 HTTP 状态码映射成 CliError；服务端给的 message 照原样显示，不改写 */
function mapHttpError(status: number, body: ApiErrorBody | null, server: string): CliError {
  const message = body?.error.message;
  switch (status) {
    case 400: {
      const lines = [message ?? "请求参数不正确", ...issueLines(body?.error.details)];
      return new CliError(EXIT.DATA, lines.join("\n"));
    }
    case 401:
      return new CliError(EXIT.AUTH, message ?? "未登录或令牌已失效", `到 ${server}/setup 取配对码，再执行 kh login --code <配对码>`);
    case 403:
      return new CliError(EXIT.AUTH, message ?? "没有权限执行此操作");
    case 404:
      return body ? new CliError(EXIT.DATA, message ?? "未找到") : missingEndpointError(server);
    case 405:
      return body ? new CliError(EXIT.DATA, message ?? "不支持的方法") : missingEndpointError(server);
    case 409:
      return new CliError(EXIT.DATA, message ?? "存在冲突");
    case 413:
      return new CliError(EXIT.DATA, message ?? "请求体过大");
    case 426:
      return new CliError(EXIT.INCOMPATIBLE, message ?? "kh 版本过旧，服务端拒绝了请求", upgradeHint(server));
    case 429: {
      // details.retryAfterSeconds 放进 hint（而不是拼进 message），message 原样保留服务端给的原因
      const parsed = rateLimitDetailsSchema.safeParse(body?.error.details);
      const hint = parsed.success ? `请等待 ${parsed.data.retryAfterSeconds} 秒后重试` : undefined;
      return new CliError(EXIT.AUTH, message ?? "请求过于频繁，请稍后再试", hint);
    }
    case 500:
      return new CliError(EXIT.UNEXPECTED, message ?? "服务端内部错误");
    case 503:
      return new CliError(EXIT.UNREACHABLE, message ?? "服务端暂时不可用");
    default:
      // 502/504 等网关错误通常不是 JSON 响应；其他未预期的状态码按服务端异常处理
      if (status >= 500) return new CliError(EXIT.UNREACHABLE, message ?? `服务端返回网关错误（状态码 ${status}）`);
      return new CliError(EXIT.UNEXPECTED, message ?? `服务端返回未预期的状态码 ${status}`);
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/** 请求头的值必须是可打印 ASCII（0x20-0x7E）：fetch 对超出 Latin-1/含控制字符的值会抛 TypeError，
 * 之前会被误判成“无法连接到服务端”。这里提前挡住，报错只提头名，不带值——不管这个头装的是
 * agent 名称还是令牌，都不应该出现在错误信息里。 */
const ASCII_HEADER_VALUE_RE = /^[\x20-\x7E]*$/;

function assertHeadersSendable(headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(headers)) {
    if (!ASCII_HEADER_VALUE_RE.test(value)) {
      throw new CliError(EXIT.UNEXPECTED, `请求头 ${name} 含有无法发送的字符`);
    }
  }
}

/** 3xx 状态码范围 */
function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

/** err.cause 里的错误码（例如 ECONNREFUSED），拿不到就是 undefined；不含任何请求头内容 */
function causeCode(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const cause = err.cause;
  if (cause && typeof cause === "object" && "code" in cause) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

type HttpMethod = "GET" | "POST" | "PATCH" | "PUT";

/** 调用 kh 服务端 API：统一请求头、超时、把失败响应映射成 CliError，成功时按 schema 解析并返回 */
export class ApiClient {
  constructor(private readonly opts: ApiClientOptions) {}

  get<S extends z.ZodType>(path: string, schema: S): Promise<z.output<S>> {
    return this.request("GET", path, undefined, schema);
  }

  post<S extends z.ZodType>(path: string, body: unknown, schema: S): Promise<z.output<S>> {
    return this.request("POST", path, body, schema);
  }

  patch<S extends z.ZodType>(path: string, body: unknown, schema: S): Promise<z.output<S>> {
    return this.request("PATCH", path, body, schema);
  }

  put<S extends z.ZodType>(path: string, body: unknown, schema: S): Promise<z.output<S>> {
    return this.request("PUT", path, body, schema);
  }

  private async request<S extends z.ZodType>(
    method: HttpMethod,
    path: string,
    body: unknown,
    schema: S,
  ): Promise<z.output<S>> {
    const url = new URL(path, this.opts.server).toString();
    const headers: Record<string, string> = { [HEADER_KH_VERSION]: KH_VERSION };
    if (this.opts.token) headers.authorization = `Bearer ${this.opts.token}`;
    if (this.opts.agent) headers[HEADER_KH_AGENT] = this.opts.agent;

    let requestBody: string | undefined;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      requestBody = JSON.stringify(body);
    }
    assertHeadersSendable(headers);

    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    // 超时要覆盖到读完响应体为止，不能在拿到响应头之后就 clearTimeout：服务端发完头就
    // 不再发数据的话，读 body 会一直挂着。这里把 fetch 和后续的 body 读取都放进同一个
    // AbortController 的作用域，finally 里统一 clearTimeout。
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.opts.fetch(url, {
        method,
        headers,
        body: requestBody,
        signal: controller.signal,
        redirect: "manual",
      });

      if (isRedirectStatus(response.status)) {
        throw this.buildRedirectError(response);
      }

      if (response.ok) {
        const data = await this.safeParseJson(response);
        const parsed = schema.safeParse(data);
        if (!parsed.success) {
          throw new CliError(EXIT.UNEXPECTED, "服务端返回的数据格式不符合预期");
        }
        return parsed.data;
      }

      throw await this.buildError(response);
    } catch (err) {
      if (err instanceof CliError) throw err;
      if (isAbortError(err)) {
        throw new CliError(EXIT.UNREACHABLE, `请求超时（超过 ${timeoutMs}ms）：${this.opts.server}`);
      }
      const code = causeCode(err);
      throw new CliError(EXIT.UNREACHABLE, `无法连接到服务端：${this.opts.server}${code ? `（${code}）` : ""}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** 收到 3xx 时不跟随重定向：多半是服务端地址配错了，提示改用 Location 解析出的 origin 重新登录 */
  private buildRedirectError(response: Response): CliError {
    const location = response.headers.get("location");
    if (!location) {
      return new CliError(EXIT.USAGE, "服务端地址发生了重定向", "响应没有带 Location，请检查服务端地址是否正确");
    }
    try {
      const origin = new URL(location, this.opts.server).origin;
      return new CliError(EXIT.USAGE, "服务端地址发生了重定向", `请改用 ${origin} 重新执行 kh login`);
    } catch {
      return new CliError(EXIT.USAGE, "服务端地址发生了重定向", "响应的 Location 不是合法地址，请检查服务端地址是否正确");
    }
  }

  private async safeParseJson(response: Response): Promise<unknown> {
    const text = await response.text();
    if (text.trim() === "") return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }

  private async buildError(response: Response): Promise<CliError> {
    const json = await this.safeParseJson(response);
    const parsed = json === undefined ? null : apiErrorSchema.safeParse(json);
    const errorBody = parsed && parsed.success ? parsed.data : null;
    return mapHttpError(response.status, errorBody, this.opts.server);
  }
}
