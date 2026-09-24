import { taskCreateInput } from "@kanban-hub/core/schema";
import { json, readJson } from "@/server/api/http";
import { apiRoute, type AnyRouteArgs } from "@/server/api/route";

export const POST = apiRoute(
  { auth: "any" },
  async ({ req, params, actor, services }: AnyRouteArgs<{ id: string }>) => {
    const input = await readJson(req, taskCreateInput);
    const task = await services.store.createTask(params.id, input, actor);
    return json(task, { status: 201 });
  },
);
