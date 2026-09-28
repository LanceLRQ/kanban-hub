import { syncManifestInput } from "@kanban-hub/core/api";
import { json, readJson } from "@/server/api/http";
import { type MachineRouteArgs, apiRoute } from "@/server/api/route";

// 文档同步第一步：一份清单最多容纳 20000 个文件条目，实测远超普通仓库体量，16MB 留出充足余量
const SYNC_MANIFEST_MAX_BYTES = 16 * 1024 * 1024;

export const dynamic = "force-dynamic";

export const POST = apiRoute(
  { auth: "machine" },
  async ({ req, params, principal, services }: MachineRouteArgs<{ id: string }>) => {
    const input = await readJson(req, syncManifestInput, { maxBytes: SYNC_MANIFEST_MAX_BYTES });
    const result = await services.store.beginSync(params.id, principal.machine.id, input);
    return json(result);
  },
);
