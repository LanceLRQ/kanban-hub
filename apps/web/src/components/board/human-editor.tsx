"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { HUMAN_KINDS, type HumanFlag, type HumanKind } from "@kanban-hub/core/schema";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useDraft } from "./use-draft";

interface HumanEditorProps {
  human: HumanFlag | null;
  /** null 表示清除；返回 false 表示保存失败 */
  onSave: (next: HumanFlag | null) => Promise<boolean>;
}

/** 待你处理：选类型、写说明、点保存；已有时可以清除 */
export function HumanEditor({ human, onSave }: HumanEditorProps) {
  const t = useTranslations("board");
  const te = useTranslations("enums");
  // 对象每次刷新都是新引用，用内容拼成的字符串作为草稿的基准
  const [draft, setDraft, reset] = useDraft<{ kind: HumanKind; note: string }>(
    { kind: human?.kind ?? "decision", note: human?.note ?? "" },
    human ? `${human.kind}:${human.note}` : "",
  );
  const [busy, setBusy] = useState(false);
  const { kind, note } = draft;

  const trimmed = note.trim();
  const unchanged = human !== null && human.kind === kind && human.note === trimmed;

  async function save(next: HumanFlag | null) {
    setBusy(true);
    const ok = await onSave(next);
    setBusy(false);
    if (!ok) reset();
  }

  return (
    <div className="flex flex-col gap-2">
      <Select value={kind} onValueChange={(v) => setDraft({ kind: v as HumanKind, note })}>
        <SelectTrigger size="sm" aria-label={t("sheet.humanKind")} className="kh-sheet-field bg-card text-[13px] font-semibold">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {HUMAN_KINDS.map((k) => (
            <SelectItem key={k} value={k}>
              {te(`humanKind.${k}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Textarea
        value={note}
        aria-label={t("sheet.human")}
        placeholder={t("sheet.humanNotePlaceholder")}
        onChange={(e) => setDraft({ kind, note: e.target.value })}
        className="kh-sheet-field min-h-14 bg-card text-[13px] font-semibold md:text-[13px]"
      />
      <div className="flex gap-2">
        <Button size="sm" disabled={busy || trimmed === "" || unchanged} onClick={() => void save({ kind, note: trimmed })}>
          {t("sheet.humanSave")}
        </Button>
        {human !== null && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void save(null)}>
            {t("sheet.humanClear")}
          </Button>
        )}
      </div>
    </div>
  );
}
