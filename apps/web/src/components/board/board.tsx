"use client";

import "./board.css";
import { useMemo, useOptimistic, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { applyBoardView, boardViewStateSchema, DEFAULT_BOARD_VIEW, isDefaultBoardView } from "@/lib/board-filter";
import { useLocalView } from "@/lib/client/use-local-view";
import type { BoardView } from "@/server/views/board";
import { BoardNav } from "./board-nav";
import { BoardToolbar } from "./board-toolbar";
import { ContainerSection } from "./container-section";
import { TaskSheet } from "./task-sheet";

/**
 * 项目看板：左栏容器导航（宽屏吸顶）+ 容器分区 + 任务侧栏。
 *
 * 侧栏由 URL 的 `?task=` 驱动：打开、关闭、切换任务都只用 `router.replace` 改 URL，不留历史记录，
 * 刷新页面后仍停在同一个任务上；`?task=` 指向不存在的任务时忽略。URL 更新要等一次服务端往返，
 * 期间用 useOptimistic 先显示目标任务，侧栏不必等网络。
 *
 * 筛选与排序只作用于各分区内的任务行，选择存在本地（所有项目共用）；侧栏查找、分区表头计数、
 * 左栏导航都仍按全部任务计算。
 */
export function Board({ view }: { view: BoardView }) {
  const t = useTranslations("board");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const [taskParam, setTaskParam] = useOptimistic(searchParams.get("task"));
  // 用户手动展开 / 收起过的已完成容器；没动过的按默认折叠
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  const [boardView, setBoardView, resetBoardView] = useLocalView("kh-board-view", boardViewStateSchema, DEFAULT_BOARD_VIEW);
  const defaultView = isDefaultBoardView(boardView);

  const tasksById = useMemo(() => new Map(view.sections.flatMap((s) => s.tasks).map((task) => [task.id, task])), [view]);
  const selected = taskParam !== null ? (tasksById.get(taskParam) ?? null) : null;

  function navigate(taskId: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (taskId === null) params.delete("task");
    else params.set("task", taskId);
    const query = params.toString();
    startTransition(() => {
      setTaskParam(taskId);
      router.replace(query === "" ? pathname : `${pathname}?${query}`, { scroll: false });
    });
  }

  if (view.sections.length === 0) return <p className="text-muted-foreground">{t("empty")}</p>;

  return (
    <div className="kh-board-layout grid gap-5 md:grid-cols-[220px_minmax(0,1fr)]">
      <BoardNav
        className="hidden md:sticky md:top-4 md:flex md:max-h-[calc(100dvh-2rem)] md:self-start"
        ariaLabel={t("nav.ariaLabel")}
        entries={view.sections.map((s) => ({
          id: s.container.id,
          code: s.container.kind === "misc" ? null : s.container.code,
          title: s.container.title,
          taskCount: s.taskCount,
        }))}
      />
      <div className="flex min-w-0 flex-col gap-6">
        <BoardToolbar state={boardView} onChange={setBoardView} onReset={resetBoardView} />
        {view.sections.map((section, index) => (
          <ContainerSection
            key={section.container.id}
            projectId={view.projectId}
            section={section}
            tasks={applyBoardView(section.tasks, boardView)}
            canCreate={defaultView}
            index={index}
            expanded={toggled[section.container.id] ?? false}
            onToggle={() => setToggled((prev) => ({ ...prev, [section.container.id]: !(prev[section.container.id] ?? false) }))}
            onOpenTask={(taskId) => navigate(taskId)}
          />
        ))}
      </div>
      <TaskSheet projectId={view.projectId} task={selected} containerOptions={view.containerOptions} onClose={() => navigate(null)} />
    </div>
  );
}
