"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { DisabledEntry } from "@/components/shell/disabled-entry";

/**
 * 项目页标签栏：看板、时间线、文档（置灰）、设置。
 * `.kh-tabs`/`.kh-tab` 是主题相关的样式钩子（见 globals.css）：主题 A 是连成一条、带偏移
 * 阴影的分段控件，当前项实心填色；主题 B 是分开的一组按钮，非当前项虚线边框，当前项
 * 实线边框并带一小条胶带装饰——两套主题共用这份标记，视觉差异全部由 `[data-theme]` 决定，
 * 组件本身不分叉。`self-start` 防止在 `flex-col` 的父容器里被拉伸成通栏。
 */
export function ProjectTabs({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const t = useTranslations("common");
  const base = `/p/${projectId}`;

  const boardHref = base;
  const timelineHref = `${base}/timeline`;
  const settingsHref = `${base}/settings`;

  return (
    <div role="tablist" aria-label={t("projectTabs.ariaLabel")} className="kh-tabs self-start">
      <ProjectTab href={boardHref} label={t("projectTabs.board")} active={pathname === boardHref} />
      <ProjectTab href={timelineHref} label={t("projectTabs.timeline")} active={pathname === timelineHref} />
      <DisabledEntry tooltip={t("disabledEntry.tooltip")} className="kh-tab bg-card">
        {t("projectTabs.docs")}
      </DisabledEntry>
      <ProjectTab href={settingsHref} label={t("projectTabs.settings")} active={pathname === settingsHref} />
    </div>
  );
}

function ProjectTab({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      role="tab"
      aria-selected={active}
      data-active={active ? "true" : undefined}
      className={cn("kh-tab", active ? "bg-secondary text-secondary-foreground" : "bg-card text-foreground hover:bg-accent")}
    >
      <span className="kh-tab-tape" aria-hidden="true" />
      {label}
    </Link>
  );
}
