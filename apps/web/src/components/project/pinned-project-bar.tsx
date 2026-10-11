"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { Cycle, Health } from "@kanban-hub/core/schema";
import { HEALTH_TONE } from "@/lib/solid-tone";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";

/** 悬浮顶栏要显示的项目信息：头部卡片第一行里一眼要看到的那几样 */
export interface PinnedProjectBarProject {
  name: string;
  cycle: Cycle;
  health: Health;
}

/**
 * 项目页悬浮顶栏：包住头部卡片（children）并观察它——卡片整个滚出视口上沿后顶栏出现，
 * 向上滚、卡片重新露头就收起。内容取卡片第一行的核心信息（返回、项目名、周期、健康度），
 * 一行放下，放不下的（焦点、位置摘要）不进来，项目名超长省略。
 *
 * 出现时把顶栏高度写进 <html> 的 --kh-pinned-bar-h：看板/时间线/文档左栏的吸顶偏移
 * （.kh-sticky-aside）和锚点跳转的 scroll-margin（.kh-scroll-offset）都按它下移让位，
 * 不与顶栏重叠；收起时归零，离开项目页时移除（见 globals.css）。
 */
export function PinnedProjectBar({ project, children }: { project: PinnedProjectBarProject; children: ReactNode }) {
  const t = useTranslations("common");
  const te = useTranslations("enums");
  const sentinelRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(false);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry) return;
      // “看不到卡片”指整个卡片滚到视口上沿之外；只要还露着头就算看得到
      setPinned(!entry.isIntersecting && entry.boundingClientRect.bottom <= 0);
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const height = pinned ? (barRef.current?.offsetHeight ?? 0) : 0;
    document.documentElement.style.setProperty("--kh-pinned-bar-h", `${height}px`);
    return () => {
      document.documentElement.style.removeProperty("--kh-pinned-bar-h");
    };
  }, [pinned]);

  return (
    <>
      <div ref={sentinelRef}>{children}</div>
      <div
        ref={barRef}
        aria-hidden={pinned ? undefined : true}
        inert={!pinned}
        className={cn(
          "kh-pinned-project-bar fixed inset-x-0 top-0 z-30 border-b bg-card/95 backdrop-blur transition-[opacity,transform] duration-200",
          pinned ? "translate-y-0 opacity-100" : "pointer-events-none -translate-y-full opacity-0",
        )}
      >
        <div className="mx-auto flex h-12 items-center gap-3 px-8 narrow:max-w-[1240px]">
          <Link href="/projects" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "shrink-0")}>
            &larr; {t("projectHeader.back")}
          </Link>
          <p className="min-w-0 flex-1 truncate text-sm font-bold tracking-tight">{project.name}</p>
          <div className="flex shrink-0 items-center gap-2.5">
            <span className="inline-flex items-center rounded-sm border bg-card px-2.5 py-0.5 text-xs font-bold">
              {te(`cycle.${project.cycle}`)}
            </span>
            <span
              className={cn(
                "kh-health-badge inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-0.5 text-xs font-bold",
                HEALTH_TONE[project.health],
              )}
            >
              {te(`health.${project.health}`)}
            </span>
          </div>
        </div>
      </div>
    </>
  );
}
