import { rawTokenInput } from "@kanban-hub/core/api";
import { KhError } from "@kanban-hub/core/errors";
import { rawTokenSecret, signRawToken } from "@/server/auth/raw-token";
import { json, readJson } from "@/server/api/http";
import { requireProject } from "@/server/api/project-view";
import { type SessionRouteArgs, apiRoute } from "@/server/api/route";

/** 网页为文档页/预览签一个 /raw 令牌；只能签给这个项目已登记位置的机器 */
export const POST = apiRoute({ auth: "session" }, async ({ req, params, services }: SessionRouteArgs<{ id: string }>) => {
  const project = requireProject(services.store, params.id);
  const { machineId } = await readJson(req, rawTokenInput);

  const hasLocation = project.locations.some((l) => l.machineId === machineId);
  if (!hasLocation) throw new KhError("not_found", "这台机器没有登记这个项目的位置");

  const secret = rawTokenSecret(services.store.auth.sessionSecret());
  const { token, expiresAt } = signRawToken(secret, { projectId: params.id, machineId }, services.now());
  return json({ token, expiresAt });
});
