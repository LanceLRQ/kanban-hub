"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { PencilIcon } from "lucide-react";
import { CYCLES, HEALTHS, type Cycle, type Health, type Project, type ProjectPatchInput } from "@kanban-hub/core/schema";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useVersionedPatch } from "@/lib/client/use-versioned-patch";

/** 项目编辑对话框需要的字段 */
export interface ProjectEditValues {
  id: string;
  name: string;
  description: string;
  cycle: Cycle;
  health: Health;
  focus: string;
  version: number;
}

/** 项目头部的“编辑”按钮 + 对话框：名称、简介、周期、健康度、焦点 */
export function ProjectEditDialog({ project }: { project: ProjectEditValues }) {
  const t = useTranslations("board");
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <PencilIcon />
          {t("projectDialog.open")}
        </Button>
      </DialogTrigger>
      <DialogContent className="kh-dialog bg-card sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("projectDialog.title")}</DialogTitle>
          <DialogDescription>{t("projectDialog.description")}</DialogDescription>
        </DialogHeader>
        {/* 数据的 version 变了（包括 409 之后的刷新）就重建表单，丢弃草稿 */}
        <ProjectForm key={project.version} project={project} onDone={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function ProjectForm({ project, onDone }: { project: ProjectEditValues; onDone: () => void }) {
  const t = useTranslations("board");
  const te = useTranslations("enums");
  const patch = useVersionedPatch(`/api/v1/projects/${project.id}`, project.version);

  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [cycle, setCycle] = useState<Cycle>(project.cycle);
  const [health, setHealth] = useState<Health>(project.health);
  const [focus, setFocus] = useState(project.focus);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (name.trim() === "") return setError(t("projectDialog.nameRequired"));
    setError(null);

    const body: ProjectPatchInput = {};
    if (name.trim() !== project.name) body.name = name.trim();
    if (description !== project.description) body.description = description;
    if (cycle !== project.cycle) body.cycle = cycle;
    if (health !== project.health) body.health = health;
    if (focus.trim() !== project.focus) body.focus = focus.trim();
    if (Object.keys(body).length === 0) return onDone();

    setBusy(true);
    const saved = await patch<Project>(body);
    setBusy(false);
    if (saved) onDone();
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <FormField id="project-name" label={t("projectDialog.name")}>
        <Input id="project-name" value={name} onChange={(e) => setName(e.target.value)} className="bg-card" />
      </FormField>
      <FormField id="project-description" label={t("projectDialog.descriptionField")}>
        <Textarea id="project-description" value={description} onChange={(e) => setDescription(e.target.value)} className="bg-card" />
      </FormField>
      <div className="grid grid-cols-2 gap-3">
        <FormField id="project-cycle" label={t("projectDialog.cycle")}>
          <Select value={cycle} onValueChange={(v) => setCycle(v as Cycle)}>
            <SelectTrigger id="project-cycle" className="w-full bg-card">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CYCLES.map((c) => (
                <SelectItem key={c} value={c}>
                  {te(`cycle.${c}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        <FormField id="project-health" label={t("projectDialog.health")}>
          <Select value={health} onValueChange={(v) => setHealth(v as Health)}>
            <SelectTrigger id="project-health" className="w-full bg-card">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {HEALTHS.map((h) => (
                <SelectItem key={h} value={h}>
                  {te(`health.${h}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      </div>
      <FormField id="project-focus" label={t("projectDialog.focus")}>
        <Input id="project-focus" value={focus} placeholder={t("projectDialog.focusPlaceholder")} onChange={(e) => setFocus(e.target.value)} className="bg-card" />
      </FormField>
      {error && (
        <p role="alert" className="text-sm font-semibold text-destructive">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          {t("projectDialog.cancel")}
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? t("projectDialog.saving") : t("projectDialog.save")}
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
