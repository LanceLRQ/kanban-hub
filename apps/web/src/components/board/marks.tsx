"use client";

import { useTranslations } from "next-intl";
import type { ContainerStatus } from "@kanban-hub/core/derive";
import type { HumanFlag, TaskStatus } from "@kanban-hub/core/schema";
import { HUMAN_TONE, statusTone } from "@/lib/solid-tone";
import { cn } from "@/lib/utils";

/**
 * 状态标记的填色：语义色来自 tokens 的 --task-*（两套主题各自取值）。待开始是空心（卡片底色），
 * 已取消用淡底 + 淡字。形状由主题决定：主题 A 是带字符的小方块，主题 B 是小圆点（见 board.css）。
 */
const STATUS_FILL: Record<ContainerStatus | TaskStatus, string> = {
  todo: "bg-card",
  in_progress: "bg-task-in-progress",
  review: "bg-task-review",
  done: "bg-task-done",
  suspended: "bg-task-suspended",
  cancelled: "bg-task-cancelled text-muted-foreground",
  backlog: "bg-card",
};

const STATUS_GLYPH: Record<ContainerStatus | TaskStatus, string> = {
  todo: "○",
  in_progress: "●",
  review: "▲",
  done: "✓",
  suspended: "■",
  cancelled: "✕",
  backlog: "…",
};

export function StatusMark({ status, small = false }: { status: ContainerStatus | TaskStatus; small?: boolean }) {
  return (
    <span
      aria-hidden="true"
      data-status={status}
      data-size={small ? "sm" : undefined}
      className={cn(
        "kh-status-mark inline-flex flex-none items-center justify-center rounded-[3px] border-[1.5px] border-border leading-none font-black",
        small ? "size-4 text-[10px]" : "size-5 text-xs",
        STATUS_FILL[status],
      )}
    >
      {STATUS_GLYPH[status]}
    </span>
  );
}

/**
 * 容器表头里的状态标签：小标记 + 状态名。进行中、待验收、已完成、挂起是实心底色 + 白字
 * （小标记也变成白色，见 board.css）；待开始、待排期、已取消保持描边。
 */
export function StatusChip({ status, label, className }: { status: ContainerStatus | TaskStatus; label: string; className?: string }) {
  const tone = statusTone(status);
  return (
    <span
      data-status={status}
      className={cn("kh-board-chip inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-xs font-bold whitespace-nowrap", tone ?? "bg-card", className)}
    >
      <StatusMark status={status} small />
      {label}
    </span>
  );
}

/** 待你处理的徽标：两套主题都是实心底色 + 白字 */
export function HumanBadge({ human, className }: { human: HumanFlag; className?: string }) {
  const t = useTranslations("board");
  const te = useTranslations("enums");
  return (
    <span
      className={cn(
        "kh-human-badge inline-flex max-w-full items-center gap-1.5 rounded-sm border px-1.5 text-[11.5px] leading-normal font-extrabold",
        HUMAN_TONE[human.kind],
        className,
      )}
    >
      <span className="truncate">{t("human.badge", { kind: te(`humanKind.${human.kind}`), note: human.note })}</span>
    </span>
  );
}
