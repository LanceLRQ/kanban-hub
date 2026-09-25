"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { encodeEventCursor } from "@kanban-hub/core/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { TimelineFilters, TimelinePage } from "@/server/views/timeline";
import { hasActiveFilters } from "./active-filters";
import { loadMoreTimelineAction } from "./actions";
import { mergeTimelineDays, reconcileRefresh, type TimelineRefreshState } from "./merge";
import "./timeline.css";
import { TimelineFilterBar } from "./timeline-filter-bar";
import { TimelineItemRow } from "./timeline-item-row";

/** 行卡片的不对称圆角按行序号循环，只在主题 B 生效（timeline.css），主题 A 下四个值都等于 --radius */
const RADIUS_CLASSES = ["kh-radius-a", "kh-radius-b", "kh-radius-c", "kh-radius-d"];

/**
 * 时间线页面的客户端外壳：筛选栏 + 按天分组的列表 + 加载更多。
 *
 * `page`（服务端按当前筛选渲染的第一页）变化时分两种情况：
 * - 筛选条件变了：父组件（页面）用 `key` 让这个组件整体重新挂载，状态从头开始，不走这里的合并；
 * - 筛选没变、只是 SSE 刷新触发了服务端重新渲染：这里把新的首页合并进已加载的状态
 *   （`reconcileRefresh`），已经“加载更多”出来的部分原样保留，分页游标和按钮状态也一并处理，
 *   见 `merge.ts` 的说明。
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
  const [state, setState] = useState<TimelineRefreshState>({ days: page.days, cursor: page.nextCursor, loadedMore: false });
  const [pending, startTransition] = useTransition();
  const knownPage = useRef(page);

  useEffect(() => {
    if (knownPage.current === page) return;
    knownPage.current = page;
    setState((prev) => reconcileRefresh(prev, page));
  }, [page]);

  function handleLoadMore() {
    const cursor = state.cursor;
    if (!cursor) return;
    startTransition(async () => {
      const result = await loadMoreTimelineAction(filters, encodeEventCursor(cursor));
      if (!result.ok) {
        toast.error(t("loadMoreFailed"));
        return;
      }
      setState((prev) => ({
        days: mergeTimelineDays(prev.days, result.page.days, false),
        cursor: result.page.nextCursor,
        loadedMore: true,
      }));
    });
  }

  const { days, cursor } = state;
  const hasFilters = hasActiveFilters(filters, fixedProjectId);
  const itemCount = days.reduce((sum, day) => sum + day.items.length, 0);
  const showProject = fixedProjectId === undefined;
  // 还有下一页时，这个数字只是“已经加载了多少条”，不是总数，文案要说清楚；
  // 全部加载完（没有 nextCursor）时才是确定的总数
  const countLabel = cursor ? t("loadedCount", { count: itemCount }) : t("totalCount", { count: itemCount });

  // 行卡片的不对称圆角按“跨天数、跨行”的整体序号循环（不是每天从头数），预先算好而不是在
  // JSX 的 map 回调里递增一个外部变量——那样会在渲染期间做可变赋值，触发 React 的纯渲染检查
  const radiusClassById = new Map<string, string>();
  for (const item of days.flatMap((day) => day.items)) {
    radiusClassById.set(item.id, RADIUS_CLASSES[radiusClassById.size % RADIUS_CLASSES.length]!);
  }

  return (
    <div className="flex flex-col gap-5">
      <section className="kh-timeline-toolbar flex flex-col gap-3 rounded-md border bg-card px-6 py-5 shadow-[var(--shadow-raised)]">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[22px] tracking-tight">{t("heading")}</h1>
          <Badge variant="outline" className="kh-num">
            {countLabel}
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
              <h2 className="kh-timeline-day-heading kh-num text-xs font-bold tracking-wide text-muted-foreground">{day.heading}</h2>
              <div className="flex flex-col gap-2">
                {day.items.map((item) => (
                  <TimelineItemRow
                    key={item.id}
                    item={item}
                    showProject={showProject}
                    radiusClass={radiusClassById.get(item.id)!}
                  />
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
