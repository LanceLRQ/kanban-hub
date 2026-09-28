import { SYNC_MAX_FILE_SIZE_LIMIT } from "@kanban-hub/core/sync";
import { json, readBytes } from "@/server/api/http";
import { type MachineRouteArgs, apiRoute } from "@/server/api/route";

export const dynamic = "force-dynamic";

export const PUT = apiRoute(
  { auth: "machine" },
  async ({ req, params, principal, services }: MachineRouteArgs<{ id: string; sha256: string }>) => {
    const bytes = await readBytes(req, { maxBytes: SYNC_MAX_FILE_SIZE_LIMIT });
    await services.store.putSyncBlob(params.id, principal.machine.id, params.sha256, bytes);
    return json({ ok: true });
  },
);
