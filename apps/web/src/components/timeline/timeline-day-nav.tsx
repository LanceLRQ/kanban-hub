"use client";

import { cn } from "@/lib/utils";

export interface TimelineDayNavEntry {
  /** YYYY-MM-DD */
  key: string;
  label: string;
  count: number;
}

/** 某一天分组在页面里的锚点 id，列表的分组和左栏的跳转共用 */
export function dayAnchorId(key: string): string {
  return `timeline-day-${key}`;
}

/** 把 YYYY-MM-DD 拆成不带前导零的年、月、日，给左栏拼“2026年9月29日”用 */
export function dayNavParts(key: string): { year: number; month: number; day: number } {
  const [year, month, day] = key.split("-").map(Number);
  return { year: year!, month: month!, day: day! };
}

/**
 * 时间线左栏：按天列出已加载的日期和条数，点击滚到当天的分组；还有下一页时底部多一项
 * “加载更多”，由外层负责滚到页面底部并加载。只负责展示，文案由外层传入。
 */
export function TimelineDayNav({
  entries,
  ariaLabel,
  hasMore,
  loading,
  loadMoreLabel,
  loadingLabel,
  onLoadMore,
  className,
}: {
  entries: TimelineDayNavEntry[];
  ariaLabel: string;
  hasMore: boolean;
  loading: boolean;
  loadMoreLabel: string;
  loadingLabel: string;
  onLoadMore: () => void;
  className?: string;
}) {
  function jumpTo(key: string) {
    document.getElementById(dayAnchorId(key))?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <nav aria-label={ariaLabel} className={cn("kh-timeline-nav flex flex-col rounded-md border bg-card p-2", className)}>
      <ul className="flex min-h-0 flex-col overflow-y-auto">
        {entries.map((entry) => (
          <li key={entry.key}>
            <button
              type="button"
              data-target={dayAnchorId(entry.key)}
              onClick={() => jumpTo(entry.key)}
              className="kh-timeline-nav-item kh-num flex w-full items-center rounded-sm px-2 py-1 text-left text-xs font-semibold hover:bg-accent"
            >
              {entry.label}
              <span className="text-muted-foreground">({entry.count})</span>
            </button>
          </li>
        ))}
      </ul>
      {hasMore && (
        <button
          type="button"
          disabled={loading}
          onClick={onLoadMore}
          className="kh-timeline-nav-more mt-1.5 shrink-0 rounded-sm border border-dashed px-2 py-1 text-xs font-semibold text-muted-foreground hover:bg-accent disabled:opacity-60"
        >
          {loading ? loadingLabel : loadMoreLabel}
        </button>
      )}
    </nav>
  );
}
