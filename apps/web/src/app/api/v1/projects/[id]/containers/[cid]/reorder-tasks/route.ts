import { taskReorderInput } from "@kanban-hub/core/schema";
import { json, readJson } from "@/server/api/http";
import { apiRoute, type AnyRouteArgs } from "@/server/api/route";

export const POST = apiRoute(
  { auth: "any" },
  async ({ req, params, actor, services }: AnyRouteArgs<{ id: string; cid: string }>) => {
    const input = await readJson(req, taskReorderInput);
    return json(await services.store.reorderTasks(params.id, params.cid, input, actor));
  },
);
