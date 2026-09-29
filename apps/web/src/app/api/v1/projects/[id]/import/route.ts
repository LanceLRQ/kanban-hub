import { importInput } from "@kanban-hub/core/api";
import { ApiError } from "@/server/api/errors";
import { json, readJson } from "@/server/api/http";
import { requireProject } from "@/server/api/project-view";
import { apiRoute, type AnyRouteArgs } from "@/server/api/route";

/** 导入文件的请求体上限：历史日志多的项目，导入文件可能远大于普通请求 */
const IMPORT_MAX_BYTES = 5 * 1024 * 1024;

/** ?dryRun=1 只计算、不写入；不带这个参数时写入 */
function readDryRun(req: Request): boolean {
  const value = new URL(req.url).searchParams.get("dryRun");
  if (value === null || value === "0" || value === "false") return false;
  if (value === "1" || value === "true") return true;
  throw new ApiError("invalid", "dryRun 只能是 1 或 0");
}

export const POST = apiRoute({ auth: "any" }, async ({ req, params, actor, services }: AnyRouteArgs<{ id: string }>) => {
  const dryRun = readDryRun(req);
  requireProject(services.store, params.id);
  const doc = await readJson(req, importInput, { maxBytes: IMPORT_MAX_BYTES });
  const summary = await services.store.applyImport(params.id, doc, actor, { dryRun });
  return json(summary);
});
