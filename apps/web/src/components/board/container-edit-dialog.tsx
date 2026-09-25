"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { PencilIcon } from "lucide-react";
import { MANUAL_STATUSES, type Container, type ContainerPatchInput, type ManualStatus } from "@kanban-hub/core/schema";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { BoardContainerView } from "@/server/views/board";
import { useVersionedPatch } from "./use-versioned-patch";

/** Radix Select 的选项值不能是空串，“无手动状态”用这个占位值表示 */
const NONE = "none";

/** 容器表头的“编辑”按钮 + 对话框：编号、标题、目标版本、目标日期、手动状态及原因 */
export function ContainerEditDialog({ projectId, container }: { projectId: string; container: BoardContainerView }) {
  const t = useTranslations("board");
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label={t("section.edit", { title: container.title })}
          onClick={(e) => e.stopPropagation()}
          className="kh-board-icon-btn inline-flex size-[26px] flex-none items-center justify-center rounded-[3px] border-[1.5px] border-border bg-card"
        >
          <PencilIcon className="size-3.5" />
        </button>
      </DialogTrigger>
      <DialogContent className="kh-dialog bg-card sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("containerDialog.title")}</DialogTitle>
          <DialogDescription>{t("containerDialog.description")}</DialogDescription>
        </DialogHeader>
        {/* 数据的 version 变了（包括 409 之后的刷新）就重建表单，丢弃草稿 */}
        <ContainerForm key={container.version} projectId={projectId} container={container} onDone={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function ContainerForm({ projectId, container, onDone }: { projectId: string; container: BoardContainerView; onDone: () => void }) {
  const t = useTranslations("board");
  const te = useTranslations("enums");
  const patch = useVersionedPatch(`/api/v1/projects/${projectId}/containers/${container.id}`, container.version);
  const isMisc = container.kind === "misc";

  const [code, setCode] = useState(container.code ?? "");
  const [title, setTitle] = useState(container.title);
  const [targetVersion, setTargetVersion] = useState(container.targetVersion ?? "");
  const [targetDate, setTargetDate] = useState(container.targetDate ?? "");
  const [manualStatus, setManualStatus] = useState<ManualStatus | typeof NONE>(container.manualStatus ?? NONE);
  const [manualReason, setManualReason] = useState(container.manualReason ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const nextStatus = manualStatus === NONE ? null : manualStatus;
    const nextReason = nextStatus === null ? null : emptyToNull(manualReason);
    if (title.trim() === "") return setError(t("containerDialog.titleRequired"));
    if (nextStatus === "suspended" && nextReason === null) return setError(t("containerDialog.reasonRequired"));
    setError(null);

    const body: ContainerPatchInput = {};
    const nextCode = emptyToNull(code);
    if (nextCode !== container.code) body.code = nextCode;
    if (title.trim() !== container.title) body.title = title.trim();
    const nextVersion = emptyToNull(targetVersion);
    if (nextVersion !== container.targetVersion) body.targetVersion = nextVersion;
    const nextDate = emptyToNull(targetDate);
    if (nextDate !== container.targetDate) body.targetDate = nextDate;
    // 手动状态与原因有跨字段约束，任一变化时一起提交
    if (!isMisc && (nextStatus !== container.manualStatus || nextReason !== container.manualReason)) {
      body.manualStatus = nextStatus;
      body.manualReason = nextReason;
    }
    if (Object.keys(body).length === 0) return onDone();

    setBusy(true);
    const saved = await patch<Container>(body);
    setBusy(false);
    if (saved) onDone();
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="grid grid-cols-[7rem_1fr] gap-3">
        <FormField id="container-code" label={t("containerDialog.code")}>
          <Input id="container-code" value={code} placeholder={t("containerDialog.codePlaceholder")} onChange={(e) => setCode(e.target.value)} className="kh-num bg-card" />
        </FormField>
        <FormField id="container-title" label={t("containerDialog.titleField")}>
          <Input id="container-title" value={title} onChange={(e) => setTitle(e.target.value)} className="bg-card" />
        </FormField>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <FormField id="container-target-version" label={t("containerDialog.targetVersion")}>
          <Input
            id="container-target-version"
            value={targetVersion}
            placeholder={t("containerDialog.targetVersionPlaceholder")}
            onChange={(e) => setTargetVersion(e.target.value)}
            className="kh-num bg-card"
          />
        </FormField>
        <FormField id="container-target-date" label={t("containerDialog.targetDate")}>
          <Input id="container-target-date" type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} className="kh-num bg-card" />
        </FormField>
      </div>
      {isMisc ? (
        <p className="text-xs text-muted-foreground">{t("containerDialog.miscHint")}</p>
      ) : (
        <div className="grid grid-cols-[10rem_1fr] gap-3">
          <FormField id="container-manual-status" label={t("containerDialog.manualStatus")}>
            <Select value={manualStatus} onValueChange={(v) => setManualStatus(v as ManualStatus | typeof NONE)}>
              <SelectTrigger id="container-manual-status" className="w-full bg-card">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{t("containerDialog.manualStatusNone")}</SelectItem>
                {MANUAL_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {te(`manualStatus.${s}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField id="container-manual-reason" label={t("containerDialog.manualReason")}>
            <Input
              id="container-manual-reason"
              value={manualReason}
              disabled={manualStatus === NONE}
              placeholder={t("containerDialog.manualReasonPlaceholder")}
              onChange={(e) => setManualReason(e.target.value)}
              className="bg-card"
            />
          </FormField>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm font-semibold text-destructive">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          {t("containerDialog.cancel")}
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? t("containerDialog.saving") : t("containerDialog.save")}
        </Button>
      </DialogFooter>
    </form>
  );
}

function FormField({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id} className="text-xs font-bold text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
