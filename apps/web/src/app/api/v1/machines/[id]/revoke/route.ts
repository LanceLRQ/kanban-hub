import { KhError } from "@kanban-hub/core/errors";
import { toMachineView } from "@/server/api/machine-view";
import { json } from "@/server/api/http";
import { apiRoute, type SessionRouteArgs } from "@/server/api/route";

export const POST = apiRoute({ auth: "session" }, async ({ params, principal, services }: SessionRouteArgs<{ id: string }>) => {
  const machine = services.store.auth.getMachine(params.id);
  // 别人的机器按不存在处理，不泄露它是否存在
  if (!machine || machine.userId !== principal.user.id) {
    throw new KhError("not_found", `机器 ${params.id} 不存在`);
  }

  // 已经吊销的机器原样返回，不报错、不再次写入
  if (machine.revokedAt !== null) return json(toMachineView(machine));

  const revoked = await services.store.auth.updateMachine(machine.id, { revokedAt: services.now().toISOString() });
  return json(toMachineView(revoked));
});
