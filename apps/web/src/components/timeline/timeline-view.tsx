"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { encodeEventCursor, type EventCursor } from "@kanban-hub/core/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { TimelineFilters, TimelinePage } from "@/server/views/timeline";
import { hasActiveFilters } from "./active-filters";
import { loadMoreTimelineAction } from "./actions";
import { mergeTimelineDays } from "./merge";
import { TimelineFilterBar } from "./timeline-filter-bar";
import { TimelineItemRow } from "./timeline-item-row";

/**
 * 时间线页面的客户端外壳：筛选栏 + 按天分组的列表 + 加载更多。
 *
 * `page`（服务端按当前筛选渲染的第一页）变化时分两种情况：
 * - 筛选条件变了：父组件（页面）用 `key` 让这个组件整体重新挂载，状态从头开始，不走这里的合并；
 * - 筛选没变、只是 SSE 刷新触发了服务端重新渲染：这里把新的首页合并进已加载的状态
 *   （`mergeTimelineDays(..., true)`），已经“加载更多”出来的部分原样保留（细节「SSE 刷新」）。
 */
export function TimelineView({
  page,
  filters,
  fixedProjectId,
}: {
  page: TimelinePage;
  filters: TimelineFilters;
  fixedProjectId?: string;
}) {
  const t = useTranslations("timeline");
  const router = useRouter();
  const pathname = usePathname();
  const [days, setDays] = useState(page.days);
  const [cursor, setCursor] = useState<EventCursor | null>(page.nextCursor);
  const [pending, startTransition] = useTransition();
  const knownPage = useRef(page);

  useEffect(() => {
    if (knownPage.current === page) return;
    knownPage.current = page;
    setDays((prev) => mergeTimelineDays(prev, page.days, true));
    setCursor(page.nextCursor);
  }, [page]);

  function handleLoadMore() {
    if (!cursor) return;
    startTransition(async () => {
      const result = await loadMoreTimelineAction(filters, encodeEventCursor(cursor));
      if (!result.ok) {
        toast.error(t("loadMoreFailed"));
        return;
      }
      setDays((prev) => mergeTimelineDays(prev, result.page.days, false));
      setCursor(result.page.nextCursor);
    });
  }

  const hasFilters = hasActiveFilters(filters, fixedProjectId);
  const itemCount = days.reduce((sum, day) => sum + day.items.length, 0);
  const showProject = fixedProjectId === undefined;

  return (
    <div className="flex flex-col gap-5">
      <section className="kh-timeline-toolbar flex flex-col gap-3 rounded-md border bg-card px-6 py-5 shadow-[var(--shadow-raised)]">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[22px] tracking-tight">{t("heading")}</h1>
          <Badge variant="outline" className="kh-num">
            {t("eventsCount", { count: itemCount })}
          </Badge>
        </div>
        <TimelineFilterBar filterOptions={page.filterOptions} filters={filters} showProjectFilter={showProject} />
      </section>

      {days.length === 0 ? (
        <EmptyState hasFilters={hasFilters} onClear={() => router.replace(pathname)} />
      ) : (
        <div className="flex flex-col gap-6">
          {days.map((day) => (
            <section key={day.key} className="flex flex-col gap-2">
              <h2 className="kh-num text-xs font-bold tracking-wide text-muted-foreground">{day.heading}</h2>
              <div className="flex flex-col gap-2">
                {day.items.map((item) => (
                  <TimelineItemRow key={item.id} item={item} showProject={showProject} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {cursor && (
        <div className="flex justify-center">
          <Button type="button" variant="outline" onClick={handleLoadMore} disabled={pending}>
            {pending ? t("loading") : t("loadMore")}
          </Button>
        </div>
      )}
    </div>
  );
}

function EmptyState({ hasFilters, onClear }: { hasFilters: boolean; onClear: () => void }) {
  const t = useTranslations("timeline");
  return (
    <div className="flex flex-col items-center gap-3 rounded-md border border-dashed bg-card px-6 py-12 text-center text-muted-foreground">
      <p>{hasFilters ? t("empty.filtered") : t("empty.none")}</p>
      {hasFilters && (
        <Button type="button" variant="outline" size="sm" onClick={onClear}>
          {t("empty.clear")}
        </Button>
      )}
    </div>
  );
}
