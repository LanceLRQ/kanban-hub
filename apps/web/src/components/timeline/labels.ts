/**
 * `/timeline`、`/p/[id]/timeline`、“加载更多”共用的 TimelineLabels 组装：
 * describeEvent 用到的枚举中文名、字段清空时的占位文案、类型筛选分组名、操作者筛选里
 * “网页”一项的中文名，都来自 next-intl 的服务端翻译（enums、events、timeline 三个命名空间）。
 */
import { getTranslations } from "next-intl/server";
import type { TimelineLabels } from "@/server/views/timeline";

export async function buildTimelineLabels(): Promise<TimelineLabels> {
  const te = await getTranslations("enums");
  const tt = await getTranslations("timeline");
  const tev = await getTranslations("events");
  return {
    enumLabel: (group, value) => te(`${group}.${value}`),
    noneLabel: tev("common.none"),
    groupLabel: (group) => te(`eventTypeGroup.${group}`),
    webActorLabel: tt("filters.actorWeb"),
  };
}
