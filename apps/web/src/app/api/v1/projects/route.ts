import { projectCreateInput } from "@kanban-hub/core/schema";
import { json, readJson } from "@/server/api/http";
import { toProjectView } from "@/server/api/project-view";
import { apiRoute } from "@/server/api/route";

// 项目列表不能在构建期被静态化，每次请求都要读最新数据
export const dynamic = "force-dynamic";

export const GET = apiRoute({ auth: "any" }, ({ req, services }) => {
  // fingerprint 只做查询，格式不对的值不会命中任何项目，自然返回空列表，不需要在这里校验格式
  const fingerprint = new URL(req.url).searchParams.get("fingerprint");
  const projects = fingerprint === null ? services.store.listProjects() : services.store.findProjectsByFingerprint(fingerprint);
  return json({ projects: projects.map((project) => toProjectView(services.store, project)) });
});

export const POST = apiRoute({ auth: "any" }, async ({ req, actor, services }) => {
  const input = await readJson(req, projectCreateInput);
  const { project, board } = await services.store.createProject(input, actor);
  return json({ project, board }, { status: 201 });
});
