"use client";

import { useTranslations } from "next-intl";
import type { ContainerStatus } from "@kanban-hub/core/derive";
import type { HumanFlag, HumanKind, TaskStatus } from "@kanban-hub/core/schema";
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

/** 容器表头与侧栏里用的状态标签：小标记 + 状态名 */
export function StatusChip({ status, label, className }: { status: ContainerStatus | TaskStatus; label: string; className?: string }) {
  return (
    <span className={cn("kh-board-chip inline-flex items-center gap-1.5 rounded-sm border bg-card px-2 py-0.5 text-xs font-bold whitespace-nowrap", className)}>
      <StatusMark status={status} small />
      {label}
    </span>
  );
}

const HUMAN_FILL: Record<HumanKind, string> = {
  decision: "bg-human-decision",
  verify: "bg-human-verify",
  action: "bg-human-action",
};

/** 待你处理的徽标：主题 A 实心填色；主题 B 米白纸底 + 语义色小圆点（见 board.css） */
export function HumanBadge({ human, className }: { human: HumanFlag; className?: string }) {
  const t = useTranslations("board");
  const te = useTranslations("enums");
  return (
    <span
      className={cn(
        "kh-human-badge inline-flex max-w-full items-center gap-1.5 rounded-sm border px-1.5 text-[11.5px] leading-normal font-extrabold",
        HUMAN_FILL[human.kind],
        className,
      )}
    >
      <span aria-hidden="true" className={cn("kh-human-dot hidden size-[7px] flex-none rounded-full border border-border", HUMAN_FILL[human.kind])} />
      <span className="truncate">{t("human.badge", { kind: te(`humanKind.${human.kind}`), note: human.note })}</span>
    </span>
  );
}
