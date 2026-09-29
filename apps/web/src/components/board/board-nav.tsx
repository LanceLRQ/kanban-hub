"use client";

import { cn } from "@/lib/utils";

export interface BoardNavEntry {
  id: string;
  code: string | null;
  title: string;
  /** 任务数（不计已取消），与容器表头的摘要一致 */
  taskCount: number;
}

/** 容器分区在页面里的锚点 id，分区和左栏的跳转共用 */
export function containerAnchorId(containerId: string): string {
  return `board-container-${containerId}`;
}

/**
 * 看板左栏：每个容器一行（编号小标签 + 标题，标题超长省略），任务数贴右；点击滚到对应容器。
 * 只做导航，不显示状态。
 */
export function BoardNav({ entries, ariaLabel, className }: { entries: BoardNavEntry[]; ariaLabel: string; className?: string }) {
  function jumpTo(id: string) {
    document.getElementById(containerAnchorId(id))?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <nav aria-label={ariaLabel} className={cn("kh-board-nav flex flex-col rounded-md border bg-card p-2", className)}>
      <ul className="flex min-h-0 flex-col overflow-y-auto">
        {entries.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              data-target={containerAnchorId(entry.id)}
              title={entry.code !== null ? `${entry.code} ${entry.title}` : entry.title}
              onClick={() => jumpTo(entry.id)}
              className="kh-board-nav-item flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-xs font-semibold hover:bg-accent"
            >
              {entry.code !== null && (
                <span className="kh-board-nav-code kh-num shrink-0 rounded-[3px] border border-border bg-background px-1 py-px text-[10px] leading-none font-extrabold">
                  {entry.code}
                </span>
              )}
              <span className="min-w-0 truncate">{entry.title}</span>
              <span className="kh-num ml-auto shrink-0 text-muted-foreground">{entry.taskCount}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
