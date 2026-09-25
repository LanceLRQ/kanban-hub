"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { TASK_STATUSES, type TaskStatus } from "@kanban-hub/core/schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { isPlainEnter } from "./editable-text";
import { StatusMark } from "./marks";

interface StatusPickerProps {
  status: TaskStatus;
  /**
   * 切换状态。切到挂起时带上原因；从挂起切走时不带原因，由服务端清空。
   * 返回 false 表示保存失败。
   */
  onChange: (status: TaskStatus, suspendReason?: string) => Promise<boolean>;
}

/** 六态切换：点击即保存；切到挂起时先展开原因输入框，原因为空不能提交 */
export function StatusPicker({ status, onChange }: StatusPickerProps) {
  const t = useTranslations("board");
  const te = useTranslations("enums");
  const [askingReason, setAskingReason] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  async function pick(next: TaskStatus) {
    if (next === status || busy) return;
    if (next === "suspended") {
      setAskingReason(true);
      return;
    }
    setAskingReason(false);
    setBusy(true);
    await onChange(next);
    setBusy(false);
  }

  async function confirmSuspend() {
    const trimmed = reason.trim();
    if (trimmed === "" || busy) return;
    setBusy(true);
    const ok = await onChange("suspended", trimmed);
    setBusy(false);
    if (ok) {
      setAskingReason(false);
      setReason("");
    }
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div role="radiogroup" aria-label={t("sheet.status")} className="flex flex-wrap gap-2">
        {TASK_STATUSES.map((s) => {
          const active = s === status || (askingReason && s === "suspended");
          return (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={s === status}
              data-active={active ? "true" : undefined}
              disabled={busy}
              onClick={() => void pick(s)}
              className={cn(
                "kh-status-opt inline-flex items-center gap-1.5 rounded-[3px] border-[1.5px] border-border bg-card px-2 py-1 text-xs font-bold transition-transform hover:translate-x-px hover:translate-y-px disabled:opacity-60",
                active && "font-black shadow-[var(--shadow-hover)]",
              )}
            >
              <StatusMark status={s} small />
              {te(`taskStatus.${s}`)}
            </button>
          );
        })}
      </div>
      {askingReason && (
        <div className="flex items-center gap-2">
          <Input
            autoFocus
            value={reason}
            aria-label={t("sheet.suspendReason")}
            placeholder={t("sheet.suspendReasonPlaceholder")}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (isPlainEnter(e)) void confirmSuspend();
            }}
            className="kh-sheet-field h-8 bg-card text-[13px] md:text-[13px]"
          />
          <Button size="sm" disabled={reason.trim() === "" || busy} onClick={() => void confirmSuspend()}>
            {t("sheet.suspendConfirm")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setAskingReason(false);
              setReason("");
            }}
          >
            {t("sheet.cancel")}
          </Button>
        </div>
      )}
    </div>
  );
}
