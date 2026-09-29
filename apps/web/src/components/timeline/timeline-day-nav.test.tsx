import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { dayAnchorId, dayNavParts, TimelineDayNav } from "./timeline-day-nav";

describe("dayNavParts", () => {
  it("把 YYYY-MM-DD 拆成不带前导零的年、月、日", () => {
    expect(dayNavParts("2026-09-05")).toEqual({ year: 2026, month: 9, day: 5 });
    expect(dayNavParts("2025-12-31")).toEqual({ year: 2025, month: 12, day: 31 });
  });
});

describe("TimelineDayNav", () => {
  const entries = [
    { key: "2026-09-29", label: "2026年9月29日", count: 4 },
    { key: "2026-09-28", label: "2026年9月28日", count: 12 },
  ];

  function render(hasMore: boolean, loading = false) {
    return renderToStaticMarkup(
      <TimelineDayNav
        entries={entries}
        ariaLabel="按日期跳转"
        hasMore={hasMore}
        loading={loading}
        loadMoreLabel="加载更多"
        loadingLabel="加载中…"
        onLoadMore={() => {}}
      />,
    );
  }

  it("每天一项：日期 + 括号里的条数，指向当天分组的锚点", () => {
    const html = render(false);
    expect(html).toContain('aria-label="按日期跳转"');
    expect(html).toContain("2026年9月29日");
    expect(html).toContain("(4)");
    expect(html).toContain("(12)");
    expect(html).toContain(`data-target="${dayAnchorId("2026-09-28")}"`);
  });

  it("还有下一页时底部多一项“加载更多”，加载中显示加载中并禁用", () => {
    expect(render(false)).not.toContain("加载更多");
    expect(render(true)).toContain("加载更多");
    const loading = render(true, true);
    expect(loading).toContain("加载中…");
    expect(loading).toMatch(/<button[^>]*disabled=""[^>]*>加载中…/);
  });
});
