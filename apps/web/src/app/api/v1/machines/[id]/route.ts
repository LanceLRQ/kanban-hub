import { machineRenameInput } from "@kanban-hub/core/api";
import { KhError } from "@kanban-hub/core/errors";
import { toMachineView } from "@/server/api/machine-view";
import { json, readJson } from "@/server/api/http";
import { apiRoute, type SessionRouteArgs } from "@/server/api/route";

/** 改机器名称。各页面按机器 ID 现查名称，改名后全站立即显示新名称 */
export const PATCH = apiRoute({ auth: "session" }, async ({ req, params, principal, services }: SessionRouteArgs<{ id: string }>) => {
  const { name } = await readJson(req, machineRenameInput);
  const machine = services.store.auth.getMachine(params.id);
  // 别人的机器按不存在处理，不泄露它是否存在
  if (!machine || machine.userId !== principal.user.id) {
    throw new KhError("not_found", `机器 ${params.id} 不存在`);
  }
  if (machine.revokedAt !== null) {
    throw new KhError("conflict", `机器“${machine.name}”已吊销，不能改名`);
  }

  const renamed = await services.store.auth.updateMachine(machine.id, { name });
  return json(toMachineView(renamed));
});
