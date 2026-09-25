"use client";

import { useState, type ChangeEvent, type KeyboardEvent, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { XIcon } from "lucide-react";
import { checklistProgress } from "@kanban-hub/core/derive";
import type { ChecklistItem, HumanFlag, Task, TaskPatchInput, TaskStatus } from "@kanban-hub/core/schema";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import type { BoardTaskView, ContainerOption } from "@/server/views/board";
import { ChecklistEditor } from "./checklist-editor";
import { DocRefsEditor } from "./doc-refs-editor";
import { EditableText } from "./editable-text";
import { HumanEditor } from "./human-editor";
import { StatusPicker } from "./status-picker";
import { useDraft } from "./use-draft";
import { useVersionedPatch } from "@/lib/client/use-versioned-patch";

interface TaskSheetProps {
  projectId: string;
  /** 为 null 时侧栏关闭 */
  task: BoardTaskView | null;
  containerOptions: ContainerOption[];
  onClose: () => void;
}

/** 任务侧栏：从右侧滑出，每个字段单独保存 */
export function TaskSheet({ projectId, task, containerOptions, onClose }: TaskSheetProps) {
  return (
    <Sheet
      open={task !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {task && <TaskSheetBody key={task.id} projectId={projectId} task={task} containerOptions={containerOptions} />}
    </Sheet>
  );
}

/** 清单的乐观显示：保存中、或者页面还没刷新到保存后的 version 时，显示本地的清单 */
interface OptimisticChecklist {
  items: ChecklistItem[];
  pending: number;
  /** 最近一次成功保存后的 version；页面刷新到这个 version 之后改用服务端数据 */
  until: number;
}

function TaskSheetBody({ projectId, task, containerOptions }: { projectId: string; task: BoardTaskView; containerOptions: ContainerOption[] }) {
  const t = useTranslations("board");
  const patch = useVersionedPatch(`/api/v1/projects/${projectId}/tasks/${task.id}`, task.version);
  const [optimistic, setOptimistic] = useState<OptimisticChecklist | null>(null);

  const checklist = optimistic && (optimistic.pending > 0 || task.version < optimistic.until) ? optimistic.items : task.checklist;
  const progress = checklistProgress(checklist);

  async function save(body: TaskPatchInput): Promise<boolean> {
    return (await patch<Task>(body)) !== null;
  }

  async function saveChecklist(next: ChecklistItem[]): Promise<boolean> {
    setOptimistic((o) => ({ items: next, pending: (o?.pending ?? 0) + 1, until: o?.until ?? 0 }));
    const result = await patch<Task>({ checklist: next });
    if (!result) {
      // 失败时回滚到服务端数据；409 之后页面会刷新成最新清单
      setOptimistic(null);
      return false;
    }
    setOptimistic((o) => (o ? { ...o, pending: o.pending - 1, until: Math.max(o.until, result.version) } : o));
    return true;
  }

  function saveStatus(status: TaskStatus, suspendReason?: string): Promise<boolean> {
    return save(suspendReason !== undefined ? { status, suspendReason } : { status });
  }

  return (
    <SheetContent
      side="right"
      showCloseButton={false}
      aria-describedby={undefined}
      className="kh-sheet w-[400px] gap-0 overflow-y-auto overscroll-contain border-l bg-card p-0 shadow-[var(--shadow-raised)] sm:max-w-[420px]"
    >
      <div className="kh-sheet-top sticky top-0 z-10 flex items-center justify-between gap-3 border-b bg-[var(--mustard)] px-5 py-3">
        <div className="flex items-center gap-3">
          <span className="kh-num text-[15px] font-extrabold">{task.ref}</span>
          {progress.total > 0 && (
            <span className="kh-num text-xs font-bold text-muted-foreground">{t("sheet.checklistCount", { done: progress.done, total: progress.total })}</span>
          )}
        </div>
        <SheetClose
          aria-label={t("sheet.close")}
          className="kh-sheet-close inline-flex size-[30px] items-center justify-center rounded-[3px] border-[1.5px] border-border bg-card shadow-[var(--shadow-raised)] transition hover:translate-x-px hover:translate-y-px hover:shadow-[var(--shadow-hover)]"
        >
          <XIcon className="size-4" />
        </SheetClose>
      </div>

      <div className="kh-sheet-block border-b border-[var(--border-soft)] px-5 pt-4 pb-3.5">
        <SheetTitle className="sr-only">{task.title}</SheetTitle>
        <SheetDescription className="sr-only">{t("sheet.description")}</SheetDescription>
        <EditableText
          value={task.title}
          required
          ariaLabel={t("sheet.title")}
          onSave={(title) => save({ title })}
          className="h-auto border-transparent bg-transparent px-1 py-1 font-[family-name:var(--cjk-heading)] text-xl leading-snug font-black shadow-none md:text-xl hover:border-[var(--border-soft)]"
        />
      </div>

      <Block label={t("sheet.status")}>
        <StatusPicker status={task.status} onChange={saveStatus} />
        {task.status === "suspended" && (
          <div className="mt-2.5 flex flex-col gap-1.5">
            <span className="text-[11px] font-bold text-muted-foreground">{t("sheet.suspendReason")}</span>
            <EditableText value={task.suspendReason ?? ""} required ariaLabel={t("sheet.suspendReason")} onSave={(suspendReason) => save({ suspendReason })} />
          </div>
        )}
      </Block>

      <Block label={t("sheet.human")}>
        <HumanEditor human={task.human} onSave={(human: HumanFlag | null) => save({ human })} />
      </Block>

      <Block label={t("sheet.checklist")}>
        <ChecklistEditor items={checklist} onChange={saveChecklist} />
      </Block>

      <Block label={t("sheet.note")}>
        <EditableText value={task.note} multiline ariaLabel={t("sheet.note")} placeholder={t("sheet.notePlaceholder")} onSave={(note) => save({ note })} />
      </Block>

      <Block label={t("sheet.container")}>
        <Select value={task.containerId} onValueChange={(containerId) => void save({ containerId })}>
          <SelectTrigger size="sm" aria-label={t("sheet.container")} className="kh-sheet-field w-full bg-card text-[13px] font-semibold">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {containerOptions.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                <span className="kh-num text-xs text-muted-foreground">{c.label}</span>
                {c.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Block>

      <div className="kh-sheet-block grid grid-cols-2 gap-3 border-b border-[var(--border-soft)] px-5 py-4">
        <Field label={t("sheet.code")}>
          <EditableText value={task.code ?? ""} ariaLabel={t("sheet.code")} placeholder={t("sheet.codePlaceholder")} onSave={(v) => save({ code: v === "" ? null : v })} />
        </Field>
        <Field label={t("sheet.group")}>
          <EditableText value={task.group ?? ""} ariaLabel={t("sheet.group")} placeholder={t("sheet.groupPlaceholder")} onSave={(v) => save({ group: v === "" ? null : v })} />
        </Field>
      </div>

      <Block label={t("sheet.dueDate")}>
        <DueDateField value={task.dueDate} onSave={(dueDate) => save({ dueDate })} />
      </Block>

      <Block label={t("sheet.docRefs")} last>
        <DocRefsEditor paths={task.docRefs} onChange={(docRefs) => save({ docRefs })} />
      </Block>
    </SheetContent>
  );
}

function Block({ label, last = false, children }: { label: string; last?: boolean; children: ReactNode }) {
  return (
    <section className={last ? "kh-sheet-block px-5 py-4" : "kh-sheet-block border-b border-[var(--border-soft)] px-5 py-4"}>
      <h3 className="kh-sheet-label mb-2.5 font-[family-name:var(--cjk)] text-[11px] font-extrabold tracking-[0.14em] text-muted-foreground">{label}</h3>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="kh-sheet-label text-[11px] font-extrabold tracking-[0.14em] text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

const FULL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 完整、合法的日期：年份 >= 1970，避免逐位输入年份时产生的中间值（如 0002-…）被当成合法日期 */
function isCompleteDate(value: string): boolean {
  return FULL_DATE_PATTERN.test(value) && Number(value.slice(0, 4)) >= 1970;
}

/**
 * 截止日期：失焦或回车时保存，避免用键盘逐位输入年份时每一步都触发一次保存。
 * 用日期选择器直接选中一个完整日期时，浏览器同样会触发 `onChange`——这种情况下满足
 * `isCompleteDate` 就立即保存，保留“选中即存”的体验。
 */
function DueDateField({ value, onSave }: { value: string | null; onSave: (next: string | null) => Promise<boolean> }) {
  const t = useTranslations("board");
  const [draft, setDraft, reset] = useDraft(value ?? "");

  async function commit(next: string) {
    if (next === "" || next === value) return;
    if (!(await onSave(next))) reset();
  }

  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    const next = e.target.value;
    setDraft(next);
    if (isCompleteDate(next)) void commit(next);
  }

  function handleBlur() {
    void commit(draft);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") void commit(draft);
  }

  return (
    <div className="flex items-center gap-2">
      <Input
        type="date"
        value={draft}
        aria-label={t("sheet.dueDate")}
        onChange={handleChange}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        className="kh-sheet-field kh-num h-8 w-44 bg-card text-[13px] md:text-[13px]"
      />
      {value !== null && (
        <button
          type="button"
          aria-label={t("sheet.dueDateClear")}
          onClick={async () => {
            if (!(await onSave(null))) reset();
          }}
          className="rounded-sm p-1 text-muted-foreground hover:text-foreground"
        >
          <XIcon className="size-3.5" />
        </button>
      )}
    </div>
  );
}
