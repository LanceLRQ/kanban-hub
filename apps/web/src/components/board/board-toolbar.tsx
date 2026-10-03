"use client";

import { useTranslations } from "next-intl";
import { TASK_STATUSES, type TaskStatus } from "@kanban-hub/core/schema";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BOARD_SORTS, isDefaultBoardView, type BoardSort, type BoardViewState } from "@/lib/board-filter";
import { StatusMark } from "./marks";

interface BoardToolbarProps {
  state: BoardViewState;
  onChange: (next: BoardViewState) => void;
  onReset: () => void;
}

/**
 * 看板的筛选与排序工具栏：状态多选标签、只看待你处理、排序下拉、方向（仅时间排序）、重置（仅偏离默认时）。
 * 没选任何状态与全选等价，所以全选时 `statuses` 存空数组。
 */
export function BoardToolbar({ state, onChange, onReset }: BoardToolbarProps) {
  const t = useTranslations("board");
  const te = useTranslations("enums");
  const selected = new Set<TaskStatus>(state.statuses.length === 0 ? TASK_STATUSES : state.statuses);

  function toggleStatus(status: TaskStatus) {
    const next = new Set(selected);
    if (next.has(status)) next.delete(status);
    else next.add(status);
    onChange({ ...state, statuses: next.size === 0 || next.size === TASK_STATUSES.length ? [] : TASK_STATUSES.filter((s) => next.has(s)) });
  }

  const timeSort = state.sort === "updated" || state.sort === "created";

  return (
    <div role="group" aria-label={t("toolbar.ariaLabel")} className="kh-board-toolbar flex flex-wrap items-center gap-x-4 gap-y-2.5">
      <div role="group" aria-label={t("toolbar.statusGroup")} className="flex flex-wrap items-center gap-2">
        {TASK_STATUSES.map((status) => (
          <Chip key={status} active={selected.has(status)} onClick={() => toggleStatus(status)}>
            <StatusMark status={status} small />
            {te(`taskStatus.${status}`)}
          </Chip>
        ))}
      </div>
      <Chip active={state.humanOnly} onClick={() => onChange({ ...state, humanOnly: !state.humanOnly })}>
        {t("toolbar.humanOnly")}
      </Chip>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={state.sort} onValueChange={(sort) => onChange({ ...state, sort: sort as BoardSort })}>
          <SelectTrigger size="sm" aria-label={t("toolbar.sortLabel")} className="kh-board-sort bg-card text-[13px] font-semibold">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {BOARD_SORTS.map((sort) => (
              <SelectItem key={sort} value={sort}>
                {t(`toolbar.sort.${sort}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {timeSort && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="board-direction"
            onClick={() => onChange({ ...state, direction: state.direction === "desc" ? "asc" : "desc" })}
            className="kh-board-filter-chip"
          >
            {t(`toolbar.direction.${state.direction}`)}
          </Button>
        )}
      </div>
      {!isDefaultBoardView(state) && (
        <Button type="button" variant="ghost" size="sm" onClick={onReset} className="kh-board-reset">
          {t("toolbar.reset")}
        </Button>
      )}
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Button
      type="button"
      variant={active ? "secondary" : "outline"}
      size="sm"
      aria-pressed={active}
      onClick={onClick}
      className="kh-board-filter-chip"
    >
      {children}
    </Button>
  );
}
