import { containerReorderInput } from "@kanban-hub/core/schema";
import { json, readJson } from "@/server/api/http";
import { apiRoute, type AnyRouteArgs } from "@/server/api/route";

export const POST = apiRoute({ auth: "any" }, async ({ req, params, actor, services }: AnyRouteArgs<{ id: string }>) => {
  const input = await readJson(req, containerReorderInput);
  return json(await services.store.reorderContainers(params.id, input, actor));
});
