import type { z } from "zod";
import { parseInput } from "@kanban-hub/core/errors";
import { KH_VERSION, isCompatibleVersion } from "@kanban-hub/core/version";
import { ApiError } from "./errors";

const DEFAULT_MAX_BYTES = 1024 * 1024; // 1 MB

/** 生成 JSON 响应，统一带上 X-KH-Version */
export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("X-KH-Version", KH_VERSION);
  return Response.json(data, { ...init, headers });
}

/** 边读边数字节数，一旦超过上限立即中止，不把整个请求体缓冲到内存里 */
async function readBodyWithLimit(req: Request, maxBytes: number): Promise<Uint8Array> {
  if (!req.body) return new Uint8Array(0);

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ApiError("payload_too_large", `请求体不能超过 ${maxBytes} 字节`);
    }
    chunks.push(value);
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/**
 * 读取请求体并按 schema 校验。先看 Content-Length 快速拒绝，
 * 但请求方可以谎报或不带这个头，所以最终以实际读到的字节数为准。
 */
export async function readJson<S extends z.ZodType>(
  req: Request,
  schema: S,
  opts: { maxBytes?: number } = {},
): Promise<z.output<S>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  const contentLength = req.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maxBytes) {
    throw new ApiError("payload_too_large", `请求体不能超过 ${maxBytes} 字节`);
  }

  const bytes = await readBodyWithLimit(req, maxBytes);
  let data: unknown;
  try {
    data = bytes.byteLength === 0 ? undefined : JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError("invalid", "请求体不是合法的 JSON");
  }
  return parseInput(schema, data);
}

/**
 * 是否带了兼容的 kh 版本号。没带这个头视为浏览器等其他客户端，不检查；
 * 带了但格式不对或版本不兼容，统一提示升级。
 */
export function checkClientVersion(headerValue: string | null): ApiError | null {
  if (headerValue === null) return null;
  if (isCompatibleVersion(headerValue, KH_VERSION)) return null;
  // kh setup 只装 skill/hook（规格 12.1），不会升级 kh 本身；真正的升级路径是 /setup 页面给出的 npm 安装命令（规格 10.1）
  return new ApiError(
    "upgrade_required",
    `kh 版本（${headerValue}）与服务端（${KH_VERSION}）不兼容，请按服务端 /setup 页面的说明重新安装 kh（npm i -g <服务端地址>/setup/kh.tgz）`,
  );
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * 只比较主机和端口，不比较协议（反向代理终结 TLS 后两边协议可能不同）。
 * Origin 的 host 要等于 X-Forwarded-Host（有的话）或 Host；配置了 publicUrl 时，它的 host 也算同源。
 */
export function isSameOrigin(req: Request, publicUrl?: string | null): boolean {
  const origin = req.headers.get("origin");
  if (!origin || origin === "null") return false;

  const originHost = hostOf(origin);
  if (!originHost) return false;

  const requestHost = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (requestHost !== null && requestHost === originHost) return true;

  if (publicUrl && hostOf(publicUrl) === originHost) return true;

  return false;
}

/** 反向代理终结 TLS 后两边协议可能不同，登录和登出都按这个规则判断原始请求是否为 https */
export function isHttps(req: Request): boolean {
  const forwarded = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  return forwarded === "https" || new URL(req.url).protocol === "https:";
}
