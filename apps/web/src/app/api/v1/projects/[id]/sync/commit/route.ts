import { syncCommitInput } from "@kanban-hub/core/api";
import { json, readJson } from "@/server/api/http";
import { type MachineRouteArgs, apiRoute } from "@/server/api/route";

export const dynamic = "force-dynamic";

export const POST = apiRoute(
  { auth: "machine" },
  async ({ req, params, principal, actor, services }: MachineRouteArgs<{ id: string }>) => {
    const input = await readJson(req, syncCommitInput);
    const result = await services.store.commitSync(params.id, principal.machine.id, input.syncId, actor);
    return json(result);
  },
);
