import { toMachineView } from "@/server/api/machine-view";
import { json } from "@/server/api/http";
import { apiRoute } from "@/server/api/route";

// 列表内容依赖当前会话，不能被构建期静态化
export const dynamic = "force-dynamic";

export const GET = apiRoute({ auth: "session" }, ({ principal, services }) => {
  const machines = services.store.auth
    .listMachines()
    .filter((m) => m.userId === principal.user.id)
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(toMachineView);

  return json({ machines });
});
