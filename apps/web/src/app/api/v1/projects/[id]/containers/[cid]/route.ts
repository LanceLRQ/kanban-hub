import { withExpectedVersion } from "@kanban-hub/core/api";
import { containerPatchInput } from "@kanban-hub/core/schema";
import { json, readJson } from "@/server/api/http";
import { apiRoute, type AnyRouteArgs } from "@/server/api/route";

export const PATCH = apiRoute(
  { auth: "any" },
  async ({ req, params, actor, services }: AnyRouteArgs<{ id: string; cid: string }>) => {
    const { patch, expectedVersion } = await readJson(req, withExpectedVersion(containerPatchInput));
    const container = await services.store.updateContainer(params.id, params.cid, patch, actor, { expectedVersion });
    return json(container);
  },
);
