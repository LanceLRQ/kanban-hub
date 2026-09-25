"use client";

import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import type { BoardSectionView } from "@/server/views/board";
import { ContainerEditDialog } from "./container-edit-dialog";
import { StatusChip } from "./marks";
import { NewTaskInput } from "./new-task-input";
import { TaskRow } from "./task-row";

/** 主题 B 给相邻容器换用不同的纸色与手裁圆角；主题 A 下这两个钩子都不改变外观 */
const RADIUS_CLASSES = ["kh-radius-c", "kh-radius-d", "kh-radius-a", "kh-radius-b"];

interface ContainerSectionProps {
  projectId: string;
  section: BoardSectionView;
  index: number;
  expanded: boolean;
  onToggle: () => void;
  onOpenTask: (taskId: string) => void;
}

/** 一个容器分区：表头（编号、标题、目标版本、状态、摘要、编辑、折叠）+ 任务行 + 新建任务 */
export function ContainerSection({ projectId, section, index, expanded, onToggle, onOpenTask }: ContainerSectionProps) {
  const t = useTranslations("board");
  const te = useTranslations("enums");
  const { container, status } = section;
  const foldable = section.collapsed;
  const folded = foldable && !expanded;

  const statusLabel =
    status === null ? null : status === "backlog" || status === "suspended" || status === "cancelled" ? te(`manualStatus.${status}`) : te(`containerStatus.${status}`);

  return (
    <section
      data-paper={index % 4}
      aria-label={container.title}
      className={cn("kh-board-section overflow-hidden border bg-card shadow-[var(--shadow-raised)]", RADIUS_CLASSES[index % 4])}
    >
      <div
        className={cn(
          "kh-board-head flex flex-wrap items-center gap-3 bg-[var(--mustard)] px-[18px] py-[11px]",
          !folded && "border-b",
          foldable && "cursor-pointer select-none hover:bg-[var(--mustard-deep)]",
        )}
        onClick={(e) => {
          // 对话框经 Portal 渲染在别处，但 React 事件仍会冒泡到这里；只响应表头自身 DOM 里的点击
          if (foldable && e.currentTarget.contains(e.target as Node)) onToggle();
        }}
      >
        {container.kind !== "misc" && container.code !== null && (
          <span className="kh-board-code kh-num rounded-[3px] border-[1.5px] border-border px-2 py-px text-[13px] font-extrabold">{container.code}</span>
        )}
        <h2 className="kh-board-title text-[17px] font-black">{container.title}</h2>
        <span className="flex flex-wrap items-center gap-2">
          {container.targetVersion !== null && (
            <span className="kh-board-chip kh-num inline-flex items-center rounded-sm border bg-card px-2 py-0.5 text-xs font-bold">{container.targetVersion}</span>
          )}
          {status !== null && statusLabel !== null && <StatusChip status={status} label={statusLabel} />}
          {container.manualReason !== null && <span className="text-xs font-semibold text-muted-foreground">{container.manualReason}</span>}
        </span>
        <span className="kh-num ml-auto text-right text-xs font-bold">{summaryText(section, t)}</span>
        <ContainerEditDialog projectId={projectId} container={container} />
        {foldable && (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={expanded ? t("section.collapse", { title: container.title }) : t("section.expand", { title: container.title })}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            className="kh-board-icon-btn kh-num inline-flex size-[26px] flex-none items-center justify-center rounded-[3px] border-[1.5px] border-border bg-card text-base leading-none font-extrabold"
          >
            {expanded ? "−" : "+"}
          </button>
        )}
      </div>
      {!folded && (
        <div className="flex flex-col">
          {section.tasks.map((task) => (
            <TaskRow key={task.id} task={task} onOpen={onOpenTask} />
          ))}
          <div className={cn(section.tasks.length > 0 && "border-t border-[var(--border-soft)]")}>
            <NewTaskInput projectId={projectId} containerId={container.id} containerTitle={container.title} />
          </div>
        </div>
      )}
    </section>
  );
}

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** 表头右侧的摘要：杂项只显示未完成数；已完成的容器写“N 个任务全部完成 · 完成日期”；其余写目标日期与任务数 */
function summaryText(section: BoardSectionView, t: Translate): string {
  const { container, status } = section;
  const cancelled = section.cancelledCount > 0 ? [t("section.cancelledNote", { count: section.cancelledCount })] : [];
  if (container.kind === "misc") return t("section.openCount", { count: section.openCount });
  if (status === "done") {
    const parts = [t("section.allDone", { count: section.taskCount })];
    if (section.completedDate !== null) parts.push(t("section.completedOn", { date: section.completedDate }));
    return [...parts, ...cancelled].join(" · ");
  }
  const parts: string[] = [];
  if (container.targetDateLabel !== null) parts.push(t("section.targetDate", { date: container.targetDateLabel }));
  parts.push(t("section.taskCount", { count: section.taskCount }));
  return [...parts, ...cancelled].join(" · ");
}
