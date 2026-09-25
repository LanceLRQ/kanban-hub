"use client";

import type { KeyboardEvent } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useDraft } from "./use-draft";

interface EditableTextProps {
  value: string;
  /** 返回 false 表示保存失败（提示已由 useMutation 给出），草稿随即丢弃 */
  onSave: (next: string) => Promise<boolean>;
  ariaLabel: string;
  placeholder?: string;
  /** 为 true 时，去掉首尾空白后为空就不保存、恢复原值 */
  required?: boolean;
  /** 多行：失焦或 Ctrl/⌘ + 回车保存，保留原样文字；单行：失焦或回车保存，去掉首尾空白 */
  multiline?: boolean;
  className?: string;
}

/** 输入法组字过程中的回车用来选词，不能当成“保存” */
export function isPlainEnter(e: KeyboardEvent): boolean {
  return e.key === "Enter" && !e.nativeEvent.isComposing;
}

/** 侧栏里的单个文本字段：失焦或回车时单独保存 */
export function EditableText({ value, onSave, ariaLabel, placeholder, required = false, multiline = false, className }: EditableTextProps) {
  const [draft, setDraft, reset] = useDraft(value);

  async function commit() {
    const next = multiline ? draft : draft.trim();
    if (next === value) {
      if (next !== draft) reset();
      return;
    }
    if (required && next.trim() === "") {
      reset();
      return;
    }
    const ok = await onSave(next);
    if (!ok) reset();
  }

  const common = {
    value: draft,
    "aria-label": ariaLabel,
    placeholder,
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onBlur: () => void commit(),
  };

  if (multiline) {
    return (
      <Textarea
        {...common}
        onKeyDown={(e) => {
          if (isPlainEnter(e) && (e.metaKey || e.ctrlKey)) e.currentTarget.blur();
        }}
        className={cn("kh-sheet-field min-h-20 bg-card text-[13px] leading-relaxed font-semibold md:text-[13px]", className)}
      />
    );
  }
  return (
    <Input
      {...common}
      onKeyDown={(e) => {
        if (isPlainEnter(e)) e.currentTarget.blur();
      }}
      className={cn("kh-sheet-field h-8 bg-card text-[13px] font-semibold md:text-[13px]", className)}
    />
  );
}
