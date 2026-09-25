/**
 * `/timeline`、`/p/[id]/timeline`、“加载更多”共用的 TimelineLabels 组装：
 * describeEvent 用到的枚举中文名、类型筛选分组名、操作者筛选里“网页”一项的中文名，
 * 都来自 next-intl 的服务端翻译（enums、timeline 两个命名空间）。
 */
import { getTranslations } from "next-intl/server";
import type { TimelineLabels } from "@/server/views/timeline";

export async function buildTimelineLabels(): Promise<TimelineLabels> {
  const te = await getTranslations("enums");
  const tt = await getTranslations("timeline");
  return {
    enumLabel: (group, value) => te(`${group}.${value}`),
    groupLabel: (group) => te(`eventTypeGroup.${group}`),
    webActorLabel: tt("filters.actorWeb"),
  };
}
