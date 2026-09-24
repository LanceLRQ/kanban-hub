import { KH_VERSION } from "@kanban-hub/core/version";
import { json } from "@/server/api/http";
import { apiRoute } from "@/server/api/route";

// 会话或令牌鉴权都能到达这里，接口本身不能被构建期静态化
export const dynamic = "force-dynamic";

export const GET = apiRoute({ auth: "any" }, ({ principal }) => {
  const machine =
    principal.kind === "machine"
      ? { id: principal.machine.id, name: principal.machine.name, os: principal.machine.os }
      : null;

  return json({
    user: { id: principal.user.id, name: principal.user.name, role: principal.user.role },
    machine,
    serverVersion: KH_VERSION,
  });
});
