"use client";

import { useTranslations } from "next-intl";
import { ProgressBar } from "@/components/progress-bar";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { BoardSectionView, BoardTaskView } from "@/server/views/board";
import { containerAnchorId } from "./board-nav";
import { ContainerEditDialog } from "./container-edit-dialog";
import { StatusChip } from "./marks";
import { NewTaskInput } from "./new-task-input";
import { TaskRow } from "./task-row";

/** 主题 B 给相邻容器换用不同的纸色与手裁圆角；主题 A 下这两个钩子都不改变外观 */
const RADIUS_CLASSES = ["kh-radius-c", "kh-radius-d", "kh-radius-a", "kh-radius-b"];

interface ContainerSectionProps {
  projectId: string;
  section: BoardSectionView;
  /** 经筛选与排序后要显示的任务；表头计数等仍取自 section */
  tasks: BoardTaskView[];
  /** 是否显示“新建任务”输入框：任务行被筛选或排序偏离默认时隐藏，避免新任务因不满足筛选条件而直接消失 */
  canCreate: boolean;
  index: number;
  expanded: boolean;
  onToggle: () => void;
  onOpenTask: (taskId: string) => void;
}

/** 一个容器分区：表头（编号、标题、目标版本、状态、进度、摘要、编辑、折叠）+ 任务行 + 新建任务 */
export function ContainerSection({ projectId, section, tasks, canCreate, index, expanded, onToggle, onOpenTask }: ContainerSectionProps) {
  const t = useTranslations("board");
  const te = useTranslations("enums");
  const { container, status } = section;
  const folded = !expanded;
  const hiddenCount = tasks.length === 0 ? section.tasks.length : 0;

  const statusLabel =
    status === null ? null : status === "backlog" || status === "suspended" || status === "cancelled" ? te(`manualStatus.${status}`) : te(`containerStatus.${status}`);

  return (
    <section
      id={containerAnchorId(container.id)}
      data-paper={index % 4}
      aria-label={container.title}
      className={cn("kh-board-section scroll-mt-4 overflow-hidden border bg-card shadow-[var(--shadow-raised)]", RADIUS_CLASSES[index % 4])}
    >
      <div
        className={cn(
          "kh-board-head flex flex-wrap items-center gap-3 bg-[var(--mustard)] px-[18px] py-[11px]",
          !folded && "border-b",
          "cursor-pointer select-none hover:bg-[var(--mustard-deep)]",
        )}
        onClick={(e) => {
          // 对话框经 Portal 渲染在别处，但 React 事件仍会冒泡到这里；只响应表头自身 DOM 里的点击
          if (e.currentTarget.contains(e.target as Node)) onToggle();
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
        <SectionProgress section={section} t={t} />
        <span className="kh-num ml-auto text-right text-xs font-bold">{summaryText(section, t)}</span>
        <ContainerEditDialog projectId={projectId} container={container} />
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
      </div>
      {!folded && (
        <div className="flex flex-col">
          {tasks.map((task) => (
            <TaskRow key={task.id} task={task} onOpen={onOpenTask} />
          ))}
          {hiddenCount > 0 && (
            <p className="px-[18px] py-[11px] text-[13px] font-semibold text-muted-foreground">{t("section.filteredHidden", { count: hiddenCount })}</p>
          )}
          {canCreate && (
            <div className={cn(tasks.length > 0 && "border-t border-[var(--border-soft)]")}>
              <NewTaskInput projectId={projectId} containerId={container.id} containerTitle={container.title} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * 标题右侧的进度：进度条（窄屏隐藏）+ 带颜色的“已完成/进行中/未开始”三个数字与总数，数字悬停时用 tooltip 说明含义。
 * 已取消的任务不计入，与进度条、项目进度的口径一致。
 */
function SectionProgress({ section, t }: { section: BoardSectionView; t: Translate }) {
  const todo = section.taskCount - section.doneCount - section.startedCount;
  const numbers = [
    { key: "done", count: section.doneCount, tip: t("section.doneTip", { count: section.doneCount }), className: "text-[var(--task-done-ink)]" },
    { key: "started", count: section.startedCount, tip: t("section.startedTip", { count: section.startedCount }), className: "text-[var(--task-in-progress-ink)]" },
    { key: "todo", count: todo, tip: t("section.todoTip", { count: todo }), className: "text-muted-foreground" },
  ];
  return (
    <span className="flex items-center gap-2.5">
      <span className="kh-board-progress hidden w-[120px] sm:flex">
        <ProgressBar done={section.doneCount} started={section.startedCount} total={section.taskCount} title={numbers.map((n) => n.tip).join(" · ")} />
      </span>
      <span className="kh-num text-xs font-bold">
        <TooltipProvider delayDuration={300}>
          {numbers.map((n, i) => (
            <span key={n.key}>
              {i > 0 && "/"}
              <Tooltip>
                <TooltipTrigger asChild>
                  <span data-count={n.key} aria-label={n.tip} className={n.className}>
                    {n.count}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" className="kh-tooltip">
                  {n.tip}
                </TooltipContent>
              </Tooltip>
            </span>
          ))}
        </TooltipProvider>
        {t("section.taskTotal", { count: section.taskCount })}
      </span>
    </span>
  );
}

/** 表头右侧的摘要：已完成的写完成日期，其余写目标日期；有已取消的任务时另注一句。任务数见 SectionProgress */
function summaryText(section: BoardSectionView, t: Translate): string {
  const { container, status } = section;
  const parts: string[] = [];
  if (status === "done") {
    if (section.completedDate !== null) parts.push(t("section.completedOn", { date: section.completedDate }));
  } else if (container.kind !== "misc" && container.targetDateLabel !== null) {
    parts.push(t("section.targetDate", { date: container.targetDateLabel }));
  }
  if (section.cancelledCount > 0) parts.push(t("section.cancelledNote", { count: section.cancelledCount }));
  return parts.join(" · ");
}
