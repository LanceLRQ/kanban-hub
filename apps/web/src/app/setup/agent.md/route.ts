import { renderAgentGuide } from "@/server/setup-guides";
import { guideResponse } from "@/server/setup-guides/respond";

// 正文里的服务地址取决于请求头，不能在构建期静态化
export const dynamic = "force-dynamic";

/** 给 agent 读的“接入本机”说明；公开，不需要登录。 */
export function GET(req: Request): Response {
  return guideResponse(req, renderAgentGuide);
}
