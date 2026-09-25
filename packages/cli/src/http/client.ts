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
      return new CliError(
        EXIT.AUTH,
        message ?? "未登录或令牌已失效",
        `到 ${server}/setup 取配对码，再执行 kh login --server ${server} --code <配对码>`,
      );
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

    const response = await this.fetchWithTimeout(url, method, headers, requestBody);

    if (response.ok) {
      const data = await this.safeParseJson(response);
      const parsed = schema.safeParse(data);
      if (!parsed.success) {
        throw new CliError(EXIT.UNEXPECTED, "服务端返回的数据格式不符合预期");
      }
      return parsed.data;
    }

    throw await this.buildError(response);
  }

  private async fetchWithTimeout(
    url: string,
    method: HttpMethod,
    headers: Record<string, string>,
    body: string | undefined,
  ): Promise<Response> {
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.opts.fetch(url, { method, headers, body, signal: controller.signal });
    } catch (err) {
      if (isAbortError(err)) {
        throw new CliError(EXIT.UNREACHABLE, `请求超时（超过 ${timeoutMs}ms）：${this.opts.server}`);
      }
      throw new CliError(EXIT.UNREACHABLE, `无法连接到服务端：${this.opts.server}`);
    } finally {
      clearTimeout(timer);
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
