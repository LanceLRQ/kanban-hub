import { withExpectedVersion } from "@kanban-hub/core/api";
import { taskPatchInput } from "@kanban-hub/core/schema";
import { json, readJson } from "@/server/api/http";
import { apiRoute, type AnyRouteArgs } from "@/server/api/route";

export const PATCH = apiRoute(
  { auth: "any" },
  async ({ req, params, actor, services }: AnyRouteArgs<{ id: string; tid: string }>) => {
    const { patch, expectedVersion } = await readJson(req, withExpectedVersion(taskPatchInput));
    const task = await services.store.updateTask(params.id, params.tid, patch, actor, { expectedVersion });
    return json(task);
  },
);
