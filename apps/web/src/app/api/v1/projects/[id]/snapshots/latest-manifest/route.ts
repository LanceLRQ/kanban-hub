import type { LatestManifestResponse } from "@kanban-hub/core/api";
import { idSchema } from "@kanban-hub/core/ids";
import { pickLatestRemote } from "@kanban-hub/core/sync";
import { ApiError } from "@/server/api/errors";
import { json } from "@/server/api/http";
import { requireProject } from "@/server/api/project-view";
import { type AnyRouteArgs, apiRoute } from "@/server/api/route";

export const dynamic = "force-dynamic";

function parseExclude(raw: string | null): string | null {
  if (raw === null || raw.trim() === "") return null;
  if (!idSchema.safeParse(raw).success) throw new ApiError("invalid", `exclude 不是合法的机器 ID：${raw}`);
  return raw;
}

export const GET = apiRoute({ auth: "any" }, ({ req, params, services }: AnyRouteArgs<{ id: string }>) => {
  const project = requireProject(services.store, params.id);
  const exclude = parseExclude(new URL(req.url).searchParams.get("exclude"));

  const manifests = services.store.listSnapshotManifests(params.id);
  const files = pickLatestRemote(manifests, exclude);
  const machines = manifests.map((m) => {
    const machine = services.store.auth.getMachine(m.machineId);
    const location = project.locations.find((l) => l.machineId === m.machineId);
    return { id: m.machineId, name: machine?.name ?? "", lastSyncAt: location?.lastSyncAt ?? null };
  });

  const body: LatestManifestResponse = { files, machines };
  return json(body);
});
