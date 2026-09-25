"use client";

import "./board.css";
import { useMemo, useOptimistic, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import type { BoardView } from "@/server/views/board";
import { ContainerSection } from "./container-section";
import { TaskSheet } from "./task-sheet";

/**
 * 项目看板：容器分区 + 任务侧栏。
 *
 * 侧栏由 URL 的 `?task=` 驱动：打开、关闭、切换任务都只用 `router.replace` 改 URL，不留历史记录，
 * 刷新页面后仍停在同一个任务上；`?task=` 指向不存在的任务时忽略。URL 更新要等一次服务端往返，
 * 期间用 useOptimistic 先显示目标任务，侧栏不必等网络。
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
    <div className="flex flex-col gap-6">
      {view.sections.map((section, index) => (
        <ContainerSection
          key={section.container.id}
          projectId={view.projectId}
          section={section}
          index={index}
          expanded={toggled[section.container.id] ?? false}
          onToggle={() => setToggled((prev) => ({ ...prev, [section.container.id]: !(prev[section.container.id] ?? false) }))}
          onOpenTask={(taskId) => navigate(taskId)}
        />
      ))}
      <TaskSheet projectId={view.projectId} task={selected} containerOptions={view.containerOptions} onClose={() => navigate(null)} />
    </div>
  );
}
