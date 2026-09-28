import { HEADER_KH_SHA256 } from "@kanban-hub/core/api";
import { snapshotPathSchema } from "@kanban-hub/core/sync";
import { ApiError } from "@/server/api/errors";
import { type AnyRouteArgs, apiRoute } from "@/server/api/route";
import { requireProject } from "@/server/api/project-view";
import { sha256Hex } from "@/server/store/snapshots";

export const dynamic = "force-dynamic";

export const GET = apiRoute(
  { auth: "any" },
  async ({ params, services }: AnyRouteArgs<{ id: string; machineId: string; path: string[] }>) => {
    requireProject(services.store, params.id);

    const rel = params.path.join("/");
    if (!snapshotPathSchema.safeParse(rel).success) throw new ApiError("invalid", `快照路径不合法：${rel}`);

    const bytes = await services.store.readSnapshotFile(params.id, params.machineId, rel);
    if (!bytes) throw new ApiError("not_found", "文件不在快照中");

    // sha256 现算而不是取清单里的值：读取不进写入队列，commit 进行中清单与文件可能短暂不一致
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        [HEADER_KH_SHA256]: sha256Hex(bytes),
      },
    });
  },
);
