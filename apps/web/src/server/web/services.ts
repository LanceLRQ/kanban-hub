import { getServices, type Services } from "@/server/services";
import { requirePageUser } from "./session";
import type { User } from "@kanban-hub/core/schema";

/**
 * 页面（服务端组件）取服务容器的入口：先用 `requirePageUser` 校验会话（未登录跳到登录页），
 * 再返回与 API 路由共用的同一个 `getServices()`。以异步函数的形式暴露是刻意的——
 * 接口本身不允许“拿到服务却没经过会话校验”的写法，每个页面和布局都必须调用这一个函数，
 * 不能绕过去直接读服务容器。
 *
 * 服务还在启动时同样抛出 `KhError("unavailable")`，由 `(app)/error.tsx` 接住并显示通用的
 * 出错提示。
 */
export async function authedPageServices(): Promise<{ services: Services; user: User }> {
  const { user } = await requirePageUser();
  return { services: getServices(), user };
}
