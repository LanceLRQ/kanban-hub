"use server";

/**
 * “加载更多”的 Server Action：只读场景（细节·全局约束），网页写操作一律走 /api/v1，这里不是写
 * 操作。/timeline 和 /p/[id]/timeline 共用这一个 action：项目内时间线由调用方把
 * `filters.projectId` 固定好再传进来。
 *
 * 这是一次不受 TypeScript 类型约束的 RPC 调用（Next 的 Server Action 运行时就是一个可以直接
 * POST 调用的端点），所以两个入参在类型上都收作 `unknown`，先用 `validateTimelineFilters`/
 * `parseTimelineCursor` 校验（不合法就返回 `{ ok: false }`，不往下传），校验通过、也确实有
 * 会话之后才调用 `loadMoreTimeline`（会话校验、取页函数的组装在 load-more.ts，可以脱离 Next
 * 上下文单测）。
 */
import type { EventCursor } from "@kanban-hub/core/api";
import { pageServices } from "@/server/web/services";
import { getPageSession } from "@/server/web/session";
import { buildTimelinePage, parseTimelineCursor, validateTimelineFilters, type TimelinePage } from "@/server/views/timeline";
import { buildTimelineLabels } from "./labels";
import { loadMoreTimeline } from "./load-more";

export type LoadMoreResult = { ok: true; page: TimelinePage } | { ok: false };

export async function loadMoreTimelineAction(rawFilters: unknown, rawCursor: unknown): Promise<LoadMoreResult> {
  const services = pageServices();

  const filters = validateTimelineFilters(services, rawFilters);
  const cursor: EventCursor | null = parseTimelineCursor(rawCursor);
  if (!filters || !cursor) return { ok: false };

  try {
    const labels = await buildTimelineLabels();
    const page = await loadMoreTimeline(
      {
        hasSession: async () => (await getPageSession()) !== null,
        buildPage: (f, c) => buildTimelinePage(services, f, c, services.now(), labels),
      },
      filters,
      cursor,
    );
    return { ok: true, page };
  } catch {
    return { ok: false };
  }
}
