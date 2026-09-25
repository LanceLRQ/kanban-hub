import { type RateLimitDetails, loginInput } from "@kanban-hub/core/api";
import { verifyPassword } from "@/server/auth/password";
import { buildSessionCookie, SESSION_TTL_MS, signSession } from "@/server/auth/session";
import { clientKey } from "@/server/auth/rate-limit";
import { ApiError } from "@/server/api/errors";
import { json, readJson, isHttps, isSameOrigin } from "@/server/api/http";
import { apiRoute } from "@/server/api/route";

export const POST = apiRoute({ auth: "none" }, async ({ req, services }) => {
  if (!isSameOrigin(req, services.publicUrl)) {
    throw new ApiError("forbidden", "请求来源不受信任，请从网页本身发起操作");
  }

  // 先读请求体（非法请求体照旧 400，不计入失败次数），再 check
  const input = await readJson(req, loginInput);

  const key = `login:${clientKey(req.headers)}`;
  const limit = services.limiter.check(key);
  if (limit.blocked) {
    const details = { retryAfterSeconds: limit.retryAfterSec } satisfies RateLimitDetails;
    throw new ApiError("rate_limited", "登录尝试过于频繁，请稍后再试", details);
  }

  // check 通过就立即占位记一次失败，再去 await scrypt 校验：中间这段 await 期间，
  // 并发的其他请求也会走到这里，靠占位保证限流计数不被并发绕过；校验通过后用
  // forgive 撤销这一次占位，避免误伤真正的失败次数
  services.limiter.recordFailure(key);

  const admin = services.store.auth.listUsers().find((u) => u.role === "admin");
  const passwordOk = admin ? await verifyPassword(input.password, admin.passwordHash) : false;
  if (!admin || !passwordOk) {
    throw new ApiError("unauthorized", "密码错误");
  }
  services.limiter.forgive(key);

  const sessionValue = signSession(
    { userId: admin.id, sessionVersion: admin.sessionVersion, expiresAt: services.now().getTime() + SESSION_TTL_MS },
    services.store.auth.sessionSecret(),
  );
  const cookie = buildSessionCookie(sessionValue, { secure: isHttps(req), maxAgeSec: SESSION_TTL_MS / 1000 });

  return json({ user: { id: admin.id, name: admin.name } }, { headers: { "Set-Cookie": cookie } });
});
