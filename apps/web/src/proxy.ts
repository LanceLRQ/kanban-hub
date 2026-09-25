import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { buildForwardedPath, KH_PATH_HEADER } from "@/lib/request-path";

/**
 * 只做一件事：把当前请求的 pathname + search 转发给下游的 Server Component（见
 * `lib/request-path.ts`）。不做任何鉴权判断——鉴权仍然只在渲染时由
 * `server/web/session.ts` 的 `requirePageSession` 完成；Proxy 这一层不能替代它，
 * 只是把 App Router 布局本身拿不到的请求路径带过去，让登录后能跳回原本要去的页面。
 */
export function proxy(request: NextRequest): NextResponse {
  const headers = new Headers(request.headers);
  headers.set(KH_PATH_HEADER, buildForwardedPath(request.nextUrl.pathname, request.nextUrl.search));
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // 排除 API 路由、Next 静态资源、kh 安装包下发、字体许可证文件——这些请求不需要页面路径
  matcher: ["/((?!api/|_next/|setup/kh\\.tgz|licenses/|favicon\\.ico).*)"],
};
