import { withExpectedVersion } from "@kanban-hub/core/api";
import { projectPatchInput } from "@kanban-hub/core/schema";
import { json, readJson } from "@/server/api/http";
import { requireBoard, requireProject, toProjectView } from "@/server/api/project-view";
import { type AnyRouteArgs, apiRoute } from "@/server/api/route";

// 项目详情不能在构建期被静态化，每次请求都要读最新数据
export const dynamic = "force-dynamic";

export const GET = apiRoute({ auth: "any" }, ({ params, services }: AnyRouteArgs<{ id: string }>) => {
  const project = requireProject(services.store, params.id);
  const board = requireBoard(services.store, params.id);
  return json({ ...toProjectView(services.store, project), board });
});

export const PATCH = apiRoute({ auth: "any" }, async ({ req, params, actor, services }: AnyRouteArgs<{ id: string }>) => {
  const { patch, expectedVersion } = await readJson(req, withExpectedVersion(projectPatchInput));
  const project = await services.store.updateProject(params.id, patch, actor, { expectedVersion });
  return json(project);
});
