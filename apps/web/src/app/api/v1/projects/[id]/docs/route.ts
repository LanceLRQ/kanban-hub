import { json } from "@/server/api/http";
import { requireProject } from "@/server/api/project-view";
import { type AnyRouteArgs, apiRoute } from "@/server/api/route";
import { buildDocsView } from "@/server/views/docs";

/** 文档树、机器列表、最近更新；不含 file 与 rawToken（那两项只在网页服务端渲染文档页时才需要） */
export const GET = apiRoute({ auth: "any" }, async ({ req, params, services }: AnyRouteArgs<{ id: string }>) => {
  requireProject(services.store, params.id);
  const machineId = new URL(req.url).searchParams.get("machine") ?? undefined;
  const view = await buildDocsView(services, params.id, { machineId }, services.now());
  const { machines, tree, recent, emptyReason } = view!;
  return json({ machines, tree, recent, emptyReason });
});
