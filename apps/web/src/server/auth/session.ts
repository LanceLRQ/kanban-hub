import { createHmac, timingSafeEqual } from "node:crypto";

/** 网页会话 cookie 里的负载；expiresAt 是毫秒时间戳 */
export interface SessionPayload {
  userId: string;
  sessionVersion: number;
  expiresAt: number;
}

/** 会话 cookie 名 */
export const SESSION_COOKIE = "kh_session";

/** 会话有效期：30 天，不续期 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 签出 `base64url(JSON).base64url(HMAC-SHA256)` 形式的自包含会话值 */
export function signSession(payload: SessionPayload, secret: string): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return `${payloadB64}.${sig}`;
}

/**
 * 校验会话值；now 与 expiresAt 同为毫秒时间戳。
 * 签名不对、格式不对（缺分隔点、payload 不是 JSON、字段缺失）、已过期，都返回 null。
 */
export function verifySession(value: string, secret: string, now: number): SessionPayload | null {
  const dot = value.indexOf(".");
  if (dot <= 0 || dot === value.length - 1) return null;
  const payloadB64 = value.slice(0, dot);
  const sig = value.slice(dot + 1);

  const expectedSig = createHmac("sha256", secret).update(payloadB64).digest("base64url");
  const sigBuf = Buffer.from(sig, "base64url");
  const expectedBuf = Buffer.from(expectedSig, "base64url");
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!isSessionPayload(parsed)) return null;
  if (parsed.expiresAt <= now) return null;
  return parsed;
}

function isSessionPayload(value: unknown): value is SessionPayload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.userId === "string" && typeof v.sessionVersion === "number" && typeof v.expiresAt === "number";
}

export interface SessionCookieOptions {
  /** 请求是 https 时才加 Secure：由调用方按 URL 协议或 X-Forwarded-Proto 判断 */
  secure: boolean;
  maxAgeSec: number;
}

/** 构造登录成功后 Set-Cookie 的值 */
export function buildSessionCookie(value: string, opts: SessionCookieOptions): string {
  return joinCookieAttrs(value, opts.secure, `Max-Age=${opts.maxAgeSec}`);
}

/** 构造登出时清除 cookie 的 Set-Cookie 值 */
export function clearSessionCookie(opts: { secure: boolean }): string {
  return joinCookieAttrs("", opts.secure, "Max-Age=0");
}

function joinCookieAttrs(value: string, secure: boolean, maxAge: string): string {
  const attrs = [`${SESSION_COOKIE}=${value}`, "HttpOnly", "SameSite=Strict", "Path=/", maxAge];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

/** 从 Cookie 请求头里取指定名字的值；大小写敏感，取不到返回 null。值本身是 base64url，不需要解转义 */
export function readCookie(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}
