import { peekServices } from "@/server/services";
import { resolvePublicUrl } from "@/server/web/public-url";

/**
 * 引导文件的公开响应：服务地址与接入页同一种取法。
 * 服务容器还没启动完成时（取不到配置），只按请求头推断，不返回 503。
 */
export function guideResponse(req: Request, render: (publicUrl: string | null) => string): Response {
  const publicUrl = resolvePublicUrl(peekServices()?.publicUrl ?? null, {
    forwardedProto: req.headers.get("x-forwarded-proto"),
    forwardedHost: req.headers.get("x-forwarded-host"),
    host: req.headers.get("host"),
  });
  return new Response(render(publicUrl), {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
