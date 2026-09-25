import { TimelineView } from "@/components/timeline/timeline-view";
import { buildTimelineLabels } from "@/components/timeline/labels";
import { pageServices } from "@/server/web/services";
import { buildTimelinePage, parseTimelineFilters } from "@/server/views/timeline";

/**
 * 项目内时间线：固定本项目，不显示项目筛选组。项目是否存在由外层 `(app)/p/[id]/layout.tsx`
 * 校验（不存在时已经 404），这里不用重复校验。
 */
export default async function ProjectTimelinePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const services = pageServices();
  const now = services.now();

  const filters = parseTimelineFilters(services, sp, { fixedProjectId: id });

  const labels = await buildTimelineLabels();
  const page = await buildTimelinePage(services, filters, undefined, now, labels);

  return <TimelineView key={JSON.stringify(filters)} page={page} filters={filters} fixedProjectId={id} />;
}
