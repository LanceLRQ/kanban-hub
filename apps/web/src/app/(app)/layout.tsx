import type { ReactNode } from "react";
import { headers } from "next/headers";
import { requirePageSession } from "@/server/web/session";
import { pageServices } from "@/server/web/services";
import { KH_PATH_HEADER, resolveForwardedPath } from "@/lib/request-path";
import { TopBar } from "@/components/shell/topbar";
import { LiveRefresh } from "@/components/live/live-refresh";

/**
 * 需要登录的页面共用的外壳：校验会话（未登录跳到登录页）、渲染顶栏、维护一条 SSE 连接。
 *
 * 校验用的 currentPath 读自 `x-kh-path` 请求头：这个头由 `src/proxy.ts` 写入，转发的是
 * 当前请求的 pathname + search（App Router 的 Server Component 布局本身拿不到请求路径，
 * 只有 Proxy 能从 `NextRequest.nextUrl` 里读到）。读不到这个头（理论上不会发生，除非
 * Proxy 被绕过或它的 matcher 排除了这个路径）时 `resolveForwardedPath` 退回 `"/"`，
 * 不影响安全性——未登录访问仍然会被拦下，只是登录后会先落到总览页。
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const h = await headers();
  const currentPath = resolveForwardedPath(h.get(KH_PATH_HEADER));
  const { user } = await requirePageSession(currentPath);
  const services = pageServices();

  return (
    <>
      <TopBar user={user} now={services.now()} />
      <LiveRefresh />
      <main className="mx-auto max-w-[1240px] px-8 py-8">{children}</main>
    </>
  );
}
