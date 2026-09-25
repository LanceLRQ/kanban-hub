import { getServices, type Services } from "@/server/services";

/**
 * 页面（服务端组件）取服务容器的入口，与 API 路由共用同一个 `getServices()`。
 * 服务还在启动时同样抛出 `KhError("unavailable")`，由 `(app)/error.tsx` 接住并显示
 * “服务还在启动，请稍后刷新”。
 */
export function pageServices(): Services {
  return getServices();
}
