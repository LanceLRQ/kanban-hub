import { encodeEventCursor, parseEventsQuery } from "@kanban-hub/core/api";
import { json } from "@/server/api/http";
import { apiRoute } from "@/server/api/route";

// 按时间倒序分页的查询，不能在构建期被静态化（参照 health 路由）
export const dynamic = "force-dynamic";

export const GET = apiRoute({ auth: "any" }, async ({ req, services }) => {
  const query = parseEventsQuery(new URL(req.url).searchParams);
  // 项目不存在时由 Store.listEvents 抛 KhError("not_found")，外壳映射成 404；
  // 游标或 limit 不合法由 parseEventsQuery 抛 KhError("invalid")，映射成 400
  const events = await services.store.listEvents(query);
  const last = events[events.length - 1];
  const nextCursor = events.length >= query.limit && last ? encodeEventCursor(last) : null;
  return json({ events, nextCursor });
});
