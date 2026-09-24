import { clearSessionCookie } from "@/server/auth/session";
import { ApiError } from "@/server/api/errors";
import { isSameOrigin } from "@/server/api/http";
import { apiRoute } from "@/server/api/route";

/** 反向代理终结 TLS 后两边协议可能不同，登录和登出都按这个规则判断原始请求是否为 https */
function isHttps(req: Request): boolean {
  const forwarded = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  return forwarded === "https" || new URL(req.url).protocol === "https:";
}

export const POST = apiRoute({ auth: "none" }, ({ req, services }) => {
  if (!isSameOrigin(req, services.publicUrl)) {
    throw new ApiError("forbidden", "请求来源不受信任，请从网页本身发起操作");
  }

  // 服务端不保存会话状态，登出只需要清除 cookie；204 不能带响应体，不用 json()
  return new Response(null, { status: 204, headers: { "Set-Cookie": clearSessionCookie({ secure: isHttps(req) }) } });
});
