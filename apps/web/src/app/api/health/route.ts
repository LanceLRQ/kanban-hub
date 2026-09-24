import { KH_VERSION } from "@kanban-hub/core/version";
import { peekStore } from "@/server/store/instance";

// 健康检查不能在构建期被静态化，每次请求都要真实响应
export const dynamic = "force-dynamic";

/**
 * 取不到存储实例（没挂在 globalThis 上，路由拿不到 register() 创建的实例）时返回 503。
 * 启动期间 Next 会让请求等 register() 执行完，所以正常运行时只会返回 200。
 */
export function GET(): Response {
  if (!peekStore()) return Response.json({ status: "starting", version: KH_VERSION }, { status: 503 });
  return Response.json({ status: "ok", version: KH_VERSION });
}
