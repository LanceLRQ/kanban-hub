import type { SnapshotManifestResponse } from "@kanban-hub/core/api";
import { ApiError } from "@/server/api/errors";
import { json } from "@/server/api/http";
import { requireProject } from "@/server/api/project-view";
import { type AnyRouteArgs, apiRoute } from "@/server/api/route";

export const dynamic = "force-dynamic";

export const GET = apiRoute({ auth: "any" }, ({ params, services }: AnyRouteArgs<{ id: string; machineId: string }>) => {
  const project = requireProject(services.store, params.id);
  const manifest = services.store.getSnapshotManifest(params.id, params.machineId);
  if (!manifest) throw new ApiError("not_found", "这台机器还没有同步过这个项目的文档");

  const machine = services.store.auth.getMachine(params.machineId);
  const location = project.locations.find((l) => l.machineId === params.machineId);

  const body: SnapshotManifestResponse = {
    machineId: manifest.machineId,
    machineName: machine?.name ?? "",
    lastSyncAt: location?.lastSyncAt ?? null,
    files: [...manifest.files],
  };
  return json(body);
});
