import { KH_VERSION } from "@kanban-hub/core/version";

// 健康检查不能在构建期被静态化，每次请求都要真实响应
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({ status: "ok", version: KH_VERSION });
}
