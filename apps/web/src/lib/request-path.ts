import { sanitizeNextPath } from "./client/next-path";

/**
 * `proxy.ts` 把当前请求的路径转发给下游用的请求头名。App Router 的 Server Component
 * 布局本身拿不到请求路径（`usePathname` 只在客户端可用），`requirePageSession` 需要知道
 * 用户原本想访问哪个页面才能在登录后跳回去，所以由 Proxy 代为读取、转发。
 */
export const KH_PATH_HEADER = "x-kh-path";

/**
 * Proxy 里的纯函数部分：把 pathname 和 search 拼成请求头的值。
 * 拼接结果同样过一遍 `sanitizeNextPath`——Proxy 转发的是请求本身的路径，理论上已经是
 * 站内路径，但这里不假设上游一定干净，两端（写入请求头、读取请求头）都做同样的校验。
 */
export function buildForwardedPath(pathname: string, search: string): string {
  return sanitizeNextPath(`${pathname}${search}`);
}

/**
 * `(app)/layout.tsx` 读到请求头之后的取值逻辑：读不到（没有 Proxy 转发、或值本身不是
 * 一个合法的站内路径）一律退回 `"/"`，不是特殊分支——`sanitizeNextPath` 对 `null` 输入
 * 本来就返回 `"/"`，这里单独导出成一个函数只是为了在布局之外单独测试这条回退路径。
 */
export function resolveForwardedPath(headerValue: string | null): string {
  return sanitizeNextPath(headerValue);
}
