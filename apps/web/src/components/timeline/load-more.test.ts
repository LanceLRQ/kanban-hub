import { describe, expect, it, vi } from "vitest";
import { loadMoreTimeline, type LoadMoreDeps } from "./load-more";

/**
 * 只测校验：`loadMoreTimeline` 没有会话时必须拒绝，且不能调用 buildTimelinePage（不会真的去查
 * 存储）。会话校验函数是注入的，这里不依赖 Next 的 cookies()/请求上下文。
 */
describe("loadMoreTimeline", () => {
  it("没有会话时拒绝，不查询存储", async () => {
    const buildPage = vi.fn();
    const deps: LoadMoreDeps = {
      hasSession: async () => false,
      buildPage,
    };

    await expect(loadMoreTimeline(deps, {}, { ts: "2026-09-24T00:00:00.000Z", id: "e0000000001" })).rejects.toThrow();
    expect(buildPage).not.toHaveBeenCalled();
  });

  it("有会话时正常返回 buildPage 的结果", async () => {
    const page = { days: [], nextCursor: null, filterOptions: { projects: [], groups: [], actors: [] } };
    const buildPage = vi.fn().mockResolvedValue(page);
    const deps: LoadMoreDeps = {
      hasSession: async () => true,
      buildPage,
    };
    const filters = { projectId: "p1" };
    const cursor = { ts: "2026-09-24T00:00:00.000Z", id: "e0000000001" };

    const result = await loadMoreTimeline(deps, filters, cursor);

    expect(result).toBe(page);
    expect(buildPage).toHaveBeenCalledWith(filters, cursor);
  });
});
