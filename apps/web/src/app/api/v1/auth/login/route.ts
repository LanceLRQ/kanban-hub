import { loginInput } from "@kanban-hub/core/api";
import { verifyPassword } from "@/server/auth/password";
import { buildSessionCookie, SESSION_TTL_MS, signSession } from "@/server/auth/session";
import { clientKey } from "@/server/auth/rate-limit";
import { ApiError } from "@/server/api/errors";
import { json, readJson, isSameOrigin } from "@/server/api/http";
import { apiRoute } from "@/server/api/route";

/** 反向代理终结 TLS 后两边协议可能不同，登录和登出都按这个规则判断原始请求是否为 https */
function isHttps(req: Request): boolean {
  const forwarded = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  return forwarded === "https" || new URL(req.url).protocol === "https:";
}

export const POST = apiRoute({ auth: "none" }, async ({ req, services }) => {
  if (!isSameOrigin(req, services.publicUrl)) {
    throw new ApiError("forbidden", "请求来源不受信任，请从网页本身发起操作");
  }

  const key = `login:${clientKey(req.headers)}`;
  const limit = services.limiter.check(key);
  if (limit.blocked) {
    throw new ApiError("rate_limited", "登录尝试过于频繁，请稍后再试", { retryAfterSeconds: limit.retryAfterSec });
  }

  const input = await readJson(req, loginInput);

  const admin = services.store.auth.listUsers().find((u) => u.role === "admin");
  const passwordOk = admin ? await verifyPassword(input.password, admin.passwordHash) : false;
  if (!admin || !passwordOk) {
    services.limiter.recordFailure(key);
    throw new ApiError("unauthorized", "密码错误");
  }

  const sessionValue = signSession(
    { userId: admin.id, sessionVersion: admin.sessionVersion, expiresAt: services.now().getTime() + SESSION_TTL_MS },
    services.store.auth.sessionSecret(),
  );
  const cookie = buildSessionCookie(sessionValue, { secure: isHttps(req), maxAgeSec: SESSION_TTL_MS / 1000 });

  return json({ user: { id: admin.id, name: admin.name } }, { headers: { "Set-Cookie": cookie } });
});
