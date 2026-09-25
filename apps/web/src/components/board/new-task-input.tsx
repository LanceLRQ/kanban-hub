"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { PlusIcon } from "lucide-react";
import type { Task } from "@kanban-hub/core/schema";
import { useMutation } from "@/lib/client/api";
import { isPlainEnter } from "./editable-text";

/**
 * 容器末尾的“新建任务”输入框：回车新建一个待开始的任务。标题去掉首尾空白后为空时不提交；
 * 成功后清空输入框，焦点留在输入框里（输入框全程不禁用），方便连续录入。
 */
export function NewTaskInput({ projectId, containerId, containerTitle }: { projectId: string; containerId: string; containerTitle: string }) {
  const t = useTranslations("board");
  const { mutate } = useMutation();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    const trimmed = title.trim();
    if (trimmed === "" || busy) return;
    setBusy(true);
    const created = await mutate<Task>(`/api/v1/projects/${projectId}/tasks`, "POST", { containerId, title: trimmed });
    setBusy(false);
    if (created) setTitle("");
  }

  return (
    <div className="kh-new-task flex items-center gap-2.5 px-[18px] py-2 text-muted-foreground">
      <PlusIcon aria-hidden="true" className="size-4 flex-none" />
      <input
        value={title}
        aria-label={t("newTask.ariaLabel", { container: containerTitle })}
        aria-busy={busy}
        placeholder={t("newTask.placeholder")}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (isPlainEnter(e)) {
            e.preventDefault();
            void submit();
          }
        }}
        className="h-8 min-w-0 flex-1 bg-transparent text-sm font-semibold text-foreground outline-none placeholder:font-medium placeholder:text-muted-foreground"
      />
    </div>
  );
}
