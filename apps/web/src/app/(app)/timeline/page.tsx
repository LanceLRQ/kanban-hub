import { TimelineView } from "@/components/timeline/timeline-view";
import { buildTimelineLabels } from "@/components/timeline/labels";
import { pageServices } from "@/server/web/services";
import { buildTimelinePage, parseTimelineFilters } from "@/server/views/timeline";

/** 跨项目时间线：三组筛选都显示，筛选条件放在 URL 查询参数里（project、type、actor） */
export default async function TimelinePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const services = pageServices();
  const now = services.now();

  const filters = parseTimelineFilters(services, sp);

  const labels = await buildTimelineLabels();
  const page = await buildTimelinePage(services, filters, undefined, now, labels);

  // key 按筛选条件区分：筛选变化时整个客户端组件重新挂载，累计加载的状态从头开始；
  // 筛选不变时（例如 SSE 刷新触发的重新渲染）沿用同一个实例，由它自己合并新首页
  return <TimelineView key={JSON.stringify(filters)} page={page} filters={filters} />;
}
