"use client";

import { useTranslations } from "next-intl";
import type { TaskMeta } from "@/lib/board";
import type { BoardTaskView } from "@/server/views/board";
import { HumanBadge, StatusMark } from "./marks";

/** 看板上的一行任务：状态、短 ID、标题（带待你处理徽标）、右侧信息；点击打开侧栏 */
export function TaskRow({ task, onOpen }: { task: BoardTaskView; onOpen: (taskId: string) => void }) {
  const te = useTranslations("enums");
  const meta = useMetaText(task.meta);

  return (
    <button
      type="button"
      onClick={() => onOpen(task.id)}
      className="kh-task-row grid w-full cursor-pointer grid-cols-[118px_82px_minmax(0,1fr)_auto] items-center gap-3.5 border-b border-[var(--border-soft)] px-[18px] py-[11px] text-left last:border-b-0 hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
    >
      <span className="flex min-w-0 items-center gap-[7px]">
        <StatusMark status={task.status} />
        <span className="text-xs font-bold whitespace-nowrap">{te(`taskStatus.${task.status}`)}</span>
      </span>
      <span className="kh-num text-[12.5px] font-extrabold">{task.ref}</span>
      <span className="min-w-0 text-[14.5px] leading-normal font-bold">
        {task.code !== null && <span className="kh-num mr-2 text-xs text-muted-foreground">{task.code}</span>}
        <span className={task.status === "cancelled" ? "text-muted-foreground line-through" : undefined}>{task.title}</span>
        {task.human && <HumanBadge human={task.human} className="ml-2.5 max-w-[22rem] align-[2px]" />}
      </span>
      {meta !== "" ? <span className="line-clamp-2 max-w-[340px] text-right text-xs leading-normal font-semibold text-muted-foreground">{meta}</span> : <span />}
    </button>
  );
}

/** 右侧信息：分组 · 文档 · 备注 · 主信息（完成于 / 截止 / 开始于 / 清单） */
function useMetaText(meta: TaskMeta): string {
  const t = useTranslations("board");
  const parts: string[] = [];
  if (meta.group !== null) parts.push(t("meta.group", { group: meta.group }));
  if (meta.docRefs.length > 0) parts.push(t("meta.docs", { paths: meta.docRefs.join("、") }));
  if (meta.note !== null) parts.push(meta.note);
  const main = meta.main;
  if (main) {
    switch (main.kind) {
      case "completed":
        parts.push(t("meta.completed", { date: main.date }));
        break;
      case "due":
        parts.push(t("meta.due", { date: main.date }));
        break;
      case "started":
        parts.push(t("meta.started", { date: main.date }));
        break;
      case "startedToday":
        parts.push(t("meta.startedToday"));
        break;
      case "checklist":
        parts.push(t("meta.checklist", { done: main.done, total: main.total }));
        break;
    }
  }
  return parts.join(" · ");
}
