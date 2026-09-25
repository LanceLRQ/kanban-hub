"use client";

import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import type { TimelineItem } from "@/server/views/timeline";
import "./timeline.css";

/**
 * 时间线的一条事件：时间、类型徽标（按事件分组上色，见 timeline.css）、描述（`events`
 * 命名空间，`describeEvent` 产出的 `{key, values}`）、项目标签（跨项目时间线才显示）、操作者
 * （细节「操作者」的显示规则：命令行操作在 agent 名后面带机器名）。
 *
 * `radiusClass` 是 `kh-radius-a/b/c/d` 之一，由 `TimelineView` 按行序号循环传入：主题 A 下
 * 四个值都等于 `--radius`，不影响外观；主题 B 下呈现“不对称手裁圆角”的效果。
 */
export function TimelineItemRow({
  item,
  showProject,
  radiusClass,
}: {
  item: TimelineItem;
  showProject: boolean;
  radiusClass: string;
}) {
  const t = useTranslations("events");
  const te = useTranslations("enums");

  return (
    <div className={cn("kh-timeline-row flex flex-wrap items-center gap-3 rounded-md border bg-card px-4 py-2.5", radiusClass)}>
      <span className="kh-num w-12 shrink-0 text-xs text-muted-foreground">{item.time}</span>
      <Badge variant="outline" data-group={item.group} className="kh-timeline-badge shrink-0">
        {te(`eventTypeGroup.${item.group}`)}
      </Badge>
      <span className="min-w-0 flex-1 text-sm">{t(item.description.key, item.description.values)}</span>
      {showProject && <span className="kh-timeline-project-tag shrink-0">{item.projectName}</span>}
      <span className="shrink-0 text-xs font-medium">
        {item.actor.secondary !== null ? `${item.actor.primary}（${item.actor.secondary}）` : item.actor.primary}
      </span>
    </div>
  );
}
