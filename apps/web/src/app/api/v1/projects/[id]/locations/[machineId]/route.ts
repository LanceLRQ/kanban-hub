import { locationInput } from "@kanban-hub/core/schema";
import { ApiError } from "@/server/api/errors";
import { json, readJson } from "@/server/api/http";
import { type MachineRouteArgs, apiRoute } from "@/server/api/route";

export const PUT = apiRoute(
  { auth: "machine" },
  async ({ req, params, principal, actor, services }: MachineRouteArgs<{ id: string; machineId: string }>) => {
    // 只允许机器给自己登记位置；在读取请求体之前判断，避免给别的机器泄露请求体校验结果
    if (params.machineId !== principal.machine.id) {
      throw new ApiError("forbidden", "只能给自己的机器登记位置");
    }
    const input = await readJson(req, locationInput);
    const project = await services.store.setLocation(params.id, params.machineId, input, actor);
    return json(project);
  },
);
