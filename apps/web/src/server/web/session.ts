import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { User } from "@kanban-hub/core/schema";
import { verifySessionCookie } from "@/server/auth/authenticate";
import { SESSION_COOKIE } from "@/server/auth/session";
import { pageServices } from "./services";

/**
 * 当前网页会话对应的用户；未登录、cookie 不合法、机器令牌（页面不接受）都返回 null。
 * 只读 cookie，不做任何跳转——跳转是 `requirePageSession` 的职责。
 */
export async function getPageSession(): Promise<{ user: User } | null> {
  // 先读 cookies()（Next 的动态 API）再取服务容器：构建期预渲染会先探测有没有用到
  // 动态 API 来决定要不要把这个路由段跳过静态生成，顺序反过来的话，services 还没启动完时
  // 抛出的 KhError 会被当成真正的渲染错误，导致构建失败，而不是被判定为动态路由
  const jar = await cookies();
  const services = pageServices();
  const value = jar.get(SESSION_COOKIE)?.value ?? null;
  return verifySessionCookie(value, { auth: services.store.auth, now: services.now });
}

/** 要求已登录；未登录时跳到 `/login?next=<currentPath>`（原样编码，不做站内路径校验——那是登录页自己的职责） */
export async function requirePageSession(currentPath: string): Promise<{ user: User }> {
  const session = await getPageSession();
  if (!session) redirect(`/login?next=${encodeURIComponent(currentPath)}`);
  return session;
}
