"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMutation } from "@/lib/client/api";

/** 机器名称的长度上限，与服务端 machineRenameInput 一致 */
const MAX_NAME_LENGTH = 100;

/**
 * 按草稿决定提交什么：去掉首尾空白后为空返回 "empty"；与当前名称相同返回 null（不用提交）；
 * 否则返回要提交的新名称。
 */
export function nextMachineName(current: string, draft: string): string | "empty" | null {
  const trimmed = draft.trim();
  if (trimmed === "") return "empty";
  return trimmed === current ? null : trimmed;
}

/** 重命名机器：对话框里改名，调用 `PATCH /api/v1/machines/:id` */
export function RenameButton({ machineId, machineName }: { machineId: string; machineName: string }) {
  const t = useTranslations("setup");
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          {t("machines.rename")}
        </Button>
      </DialogTrigger>
      <DialogContent className="kh-dialog bg-card sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("machines.renameTitle")}</DialogTitle>
          <DialogDescription>{t("machines.renameDescription")}</DialogDescription>
        </DialogHeader>
        {/* 每次打开都从当前名称开始，不保留上次没提交的草稿 */}
        {open && <RenameForm machineId={machineId} machineName={machineName} onDone={() => setOpen(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function RenameForm({ machineId, machineName, onDone }: { machineId: string; machineName: string; onDone: () => void }) {
  const t = useTranslations("setup");
  const { mutate } = useMutation();
  const [draft, setDraft] = useState(machineName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const next = nextMachineName(machineName, draft);
    if (next === "empty") return setError(t("machines.renameRequired"));
    if (next === null) return onDone();
    setError(null);

    setBusy(true);
    const saved = await mutate(`/api/v1/machines/${machineId}`, "PATCH", { name: next });
    setBusy(false);
    if (saved) onDone();
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`machine-name-${machineId}`} className="text-xs font-bold text-muted-foreground">
          {t("machines.renameField")}
        </Label>
        <Input
          id={`machine-name-${machineId}`}
          value={draft}
          maxLength={MAX_NAME_LENGTH}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          className="bg-card"
        />
      </div>
      {error && (
        <p role="alert" className="text-sm font-semibold text-destructive">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          {t("machines.renameCancel")}
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? t("machines.renameSaving") : t("machines.renameSave")}
        </Button>
      </DialogFooter>
    </form>
  );
}
