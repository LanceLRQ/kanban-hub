import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import type { User } from "@kanban-hub/core/schema";
import { verifySessionCookie } from "@/server/auth/authenticate";
import { SESSION_COOKIE } from "@/server/auth/session";
import { getServices } from "@/server/services";
import { KH_PATH_HEADER, resolveForwardedPath } from "@/lib/request-path";

/**
 * 当前网页会话对应的用户；未登录、cookie 不合法、机器令牌（页面不接受）都返回 null。
 * 只读 cookie，不做任何跳转——跳转是 `requirePageSession` 的职责。
 */
export async function getPageSession(): Promise<{ user: User } | null> {
  // 先读 cookies()（Next 的动态 API）再取服务容器：构建期预渲染会先探测有没有用到
  // 动态 API 来决定要不要把这个路由段跳过静态生成，顺序反过来的话，services 还没启动完时
  // 抛出的 KhError 会被当成真正的渲染错误，导致构建失败，而不是被判定为动态路由
  const jar = await cookies();
  const services = getServices();
  const value = jar.get(SESSION_COOKIE)?.value ?? null;
  return verifySessionCookie(value, { auth: services.store.auth, now: services.now });
}

/** 要求已登录；未登录时跳到 `/login?next=<currentPath>`（原样编码，不做站内路径校验——那是登录页自己的职责） */
export async function requirePageSession(currentPath: string): Promise<{ user: User }> {
  const session = await getPageSession();
  if (!session) redirect(`/login?next=${encodeURIComponent(currentPath)}`);
  return session;
}

/**
 * 页面（服务端组件）会话校验的统一入口：读 `x-kh-path` 请求头得到当前路径，未登录时跳到
 * 登录页。用 React 的 `cache` 包装，保证同一次渲染里布局和页面都调用它时只真正校验一次。
 *
 * 这个头由 `src/proxy.ts` 写入，转发的是当前请求的 pathname + search（App Router 的
 * Server Component 本身拿不到请求路径，只有 Proxy 能从 `NextRequest.nextUrl` 里读到）。
 * 读不到这个头（理论上不会发生，除非 Proxy 被绕过或它的 matcher 排除了这个路径）时
 * `resolveForwardedPath` 退回 `"/"`，不影响安全性——未登录访问仍然会被拦下，只是登录后
 * 会先落到总览页。
 *
 * 必须由每个需要鉴权的页面和布局直接调用（通过 `authedPageServices`），不能只放在
 * `(app)/layout.tsx` 里：App Router 的局部渲染（RSC 导航）按需只重跑发生变化的那一段，
 * 不会重新执行没有变化的祖先布局，单独放在布局里挡不住这类请求拿到页面数据。
 */
export const requirePageUser = cache(async (): Promise<{ user: User }> => {
  const h = await headers();
  return requirePageSession(resolveForwardedPath(h.get(KH_PATH_HEADER)));
});
