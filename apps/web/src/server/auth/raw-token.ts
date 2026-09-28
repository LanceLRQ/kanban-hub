import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * `/raw` 令牌的负载：项目 ID、机器 ID、过期时间（毫秒时间戳）；不含路径——demo 页面用相对
 * 路径加载的子资源，同一个令牌就都能访问，不用为每个文件单独签发。
 */
export interface RawTokenPayload {
  projectId: string;
  machineId: string;
  expiresAt: number;
}

/** `/raw` 令牌的有效期：12 小时 */
export const RAW_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

const DERIVE_LABEL = "raw";

/** 由会话签名密钥派生出 `/raw` 令牌专用的签名密钥，与会话签名互不相通 */
export function rawTokenSecret(sessionSecret: string): Buffer {
  return createHmac("sha256", sessionSecret).update(DERIVE_LABEL).digest();
}

/** 签出 `base64url(JSON).base64url(HMAC-SHA256)` 形式的 /raw 令牌；有效期固定 12 小时 */
export function signRawToken(secret: Buffer, target: { projectId: string; machineId: string }, now: Date): { token: string; expiresAt: string } {
  const expiresAtMs = now.getTime() + RAW_TOKEN_TTL_MS;
  const payload: RawTokenPayload = { projectId: target.projectId, machineId: target.machineId, expiresAt: expiresAtMs };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return { token: `${payloadB64}.${sig}`, expiresAt: new Date(expiresAtMs).toISOString() };
}

/**
 * 校验 /raw 令牌；now 是毫秒时间戳。
 * 签名不对、格式不对返回 null；过期返回 "expired"；都通过时返回项目 ID 与机器 ID。
 */
export function verifyRawToken(secret: Buffer, token: string, now: number): { projectId: string; machineId: string } | "expired" | null {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);

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
  if (!isRawTokenPayload(parsed)) return null;
  if (parsed.expiresAt <= now) return "expired";
  return { projectId: parsed.projectId, machineId: parsed.machineId };
}

function isRawTokenPayload(value: unknown): value is RawTokenPayload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.projectId === "string" && typeof v.machineId === "string" && typeof v.expiresAt === "number";
}
