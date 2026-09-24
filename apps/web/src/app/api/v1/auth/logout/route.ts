import { clearSessionCookie } from "@/server/auth/session";
import { ApiError } from "@/server/api/errors";
import { isHttps, isSameOrigin } from "@/server/api/http";
import { apiRoute } from "@/server/api/route";

export const POST = apiRoute({ auth: "none" }, ({ req, services }) => {
  if (!isSameOrigin(req, services.publicUrl)) {
    throw new ApiError("forbidden", "请求来源不受信任，请从网页本身发起操作");
  }

  // 服务端不保存会话状态，登出只需要清除 cookie；204 不能带响应体，不用 json()
  return new Response(null, { status: 204, headers: { "Set-Cookie": clearSessionCookie({ secure: isHttps(req) }) } });
});
