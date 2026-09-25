/**
 * “加载更多”的只读逻辑：先校验有没有页面会话，再取下一页。会话校验函数、取页函数都由调用方
 * 注入，这里不直接依赖 Next 的 cookies()/请求上下文，方便单测（见 load-more.test.ts）。
 * 真正暴露给客户端组件的 Server Action 在 actions.ts，负责组装这里需要的依赖。
 */
import type { EventCursor } from "@/server/store/store";
import type { TimelineFilters, TimelinePage } from "@/server/views/timeline";

export interface LoadMoreDeps {
  /** 是否存在有效的页面会话；返回 false 时直接拒绝，不会调用 buildPage */
  hasSession(): Promise<boolean>;
  /** 已经绑定好 services / now / labels 的 buildTimelinePage 调用 */
  buildPage(filters: TimelineFilters, cursor: EventCursor): Promise<TimelinePage>;
}

export async function loadMoreTimeline(deps: LoadMoreDeps, filters: TimelineFilters, cursor: EventCursor): Promise<TimelinePage> {
  if (!(await deps.hasSession())) throw new Error("未登录");
  return deps.buildPage(filters, cursor);
}
