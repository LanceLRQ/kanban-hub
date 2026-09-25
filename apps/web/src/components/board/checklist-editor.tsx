"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { XIcon } from "lucide-react";
import type { ChecklistItem } from "@kanban-hub/core/schema";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { EditableText, isPlainEnter } from "./editable-text";

interface ChecklistEditorProps {
  items: ChecklistItem[];
  /** 以整个清单数组保存；返回 false 表示失败（调用方负责回滚乐观显示） */
  onChange: (next: ChecklistItem[]) => Promise<boolean>;
}

/** 清单：勾选、改文字、删除、在末尾增加 */
export function ChecklistEditor({ items, onChange }: ChecklistEditorProps) {
  const t = useTranslations("board");
  const [adding, setAdding] = useState("");

  async function add() {
    const text = adding.trim();
    if (text === "") return;
    setAdding("");
    const ok = await onChange([...items, { text, done: false }]);
    if (!ok) setAdding(text);
  }

  return (
    <div className="flex flex-col">
      {items.map((item, i) => (
        <div key={i} className="group flex items-center gap-2.5 py-1">
          <label className="relative flex flex-none cursor-pointer items-center">
            <input
              type="checkbox"
              className="peer sr-only"
              checked={item.done}
              aria-label={t("sheet.checklistToggle", { text: item.text })}
              onChange={(e) => void onChange(items.map((it, j) => (j === i ? { ...it, done: e.target.checked } : it)))}
            />
            <span
              aria-hidden="true"
              className="kh-check-box inline-flex size-5 items-center justify-center rounded-[3px] border-[1.5px] border-border bg-card font-mono text-xs font-extrabold text-transparent peer-checked:bg-foreground peer-checked:text-card peer-focus-visible:ring-2 peer-focus-visible:ring-ring"
            >
              ✓
            </span>
          </label>
          <EditableText
            value={item.text}
            required
            ariaLabel={item.text}
            onSave={(text) => onChange(items.map((it, j) => (j === i ? { ...it, text } : it)))}
            className={cn("h-7 border-transparent bg-transparent shadow-none hover:border-[var(--border-soft)]", item.done && "text-muted-foreground line-through")}
          />
          <button
            type="button"
            aria-label={t("sheet.checklistRemove", { text: item.text })}
            onClick={() => void onChange(items.filter((_, j) => j !== i))}
            className="flex-none rounded-sm p-1 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100"
          >
            <XIcon className="size-3.5" />
          </button>
        </div>
      ))}
      <Input
        value={adding}
        aria-label={t("sheet.checklistAddPlaceholder")}
        placeholder={t("sheet.checklistAddPlaceholder")}
        onChange={(e) => setAdding(e.target.value)}
        onKeyDown={(e) => {
          if (isPlainEnter(e)) void add();
        }}
        className="kh-sheet-field mt-1.5 h-8 bg-card text-[13px] md:text-[13px]"
      />
    </div>
  );
}
