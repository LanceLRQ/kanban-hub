import { pullReportInput } from "@kanban-hub/core/api";
import { json, readJson } from "@/server/api/http";
import { type MachineRouteArgs, apiRoute } from "@/server/api/route";

export const dynamic = "force-dynamic";

export const POST = apiRoute(
  { auth: "machine" },
  async ({ req, params, actor, services }: MachineRouteArgs<{ id: string }>) => {
    const input = await readJson(req, pullReportInput);
    await services.store.recordPull(params.id, input, actor);
    return json({ ok: true });
  },
);
