"use client";

import { ChevronDownIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  BOARD_FILTER_MODES,
  BOARD_SORTS,
  BOARD_STATUS_OPTIONS,
  isDefaultBoardView,
  isStatusFilterActive,
  type BoardFilterMode,
  type BoardSort,
  type BoardStatusOption,
  type BoardViewState,
} from "@/lib/board-filter";
import { FilterChip } from "@/components/filters/filter-chip";
import { StatusMark } from "./marks";

interface BoardToolbarProps {
  state: BoardViewState;
  onChange: (next: BoardViewState) => void;
  onReset: () => void;
}

/**
 * 看板的筛选与排序工具栏：状态多选下拉、筛选方式（状态已选时才出现）、只看待你处理、排序下拉、
 * 方向（仅时间排序）、重置（仅偏离默认时）。没选任何状态与全选等价，所以全选时 `statuses` 存空数组。
 */
export function BoardToolbar({ state, onChange, onReset }: BoardToolbarProps) {
  const t = useTranslations("board");
  const te = useTranslations("enums");
  const selected = new Set<BoardStatusOption>(state.statuses);
  const statusActive = isStatusFilterActive(state.statuses);

  const optionLabel = (status: BoardStatusOption) => (status === "backlog" ? te("manualStatus.backlog") : te(`taskStatus.${status}`));

  function toggleStatus(status: BoardStatusOption) {
    const next = new Set(selected);
    if (next.has(status)) next.delete(status);
    else next.add(status);
    onChange({ ...state, statuses: next.size === BOARD_STATUS_OPTIONS.length ? [] : BOARD_STATUS_OPTIONS.filter((s) => next.has(s)) });
  }

  // 按下拉里的顺序取第一项；全选存成空数组，按钮上视同没选
  const picked = BOARD_STATUS_OPTIONS.filter((s) => selected.has(s));
  const statusText =
    picked.length === 0 || !statusActive
      ? t("toolbar.status")
      : picked.length === 1
        ? t("toolbar.statusOne", { first: optionLabel(picked[0]!) })
        : t("toolbar.statusMany", { first: optionLabel(picked[0]!), count: picked.length });

  const timeSort = state.sort === "updated" || state.sort === "created";

  return (
    <div role="group" aria-label={t("toolbar.ariaLabel")} className="kh-board-toolbar flex flex-wrap items-center gap-x-4 gap-y-2.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="sm" className="kh-board-status-trigger text-[13px] font-semibold">
            {statusText}
            <ChevronDownIcon className="size-4 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {BOARD_STATUS_OPTIONS.map((status) => (
            <DropdownMenuCheckboxItem
              key={status}
              checked={statusActive && selected.has(status)}
              onCheckedChange={() => toggleStatus(status)}
              // 多选：选中后菜单保持打开
              onSelect={(e) => e.preventDefault()}
            >
              <StatusMark status={status} small />
              {optionLabel(status)}
              {status === "review" && <span className="text-xs text-muted-foreground">{t("toolbar.taskOnly")}</span>}
              {status === "backlog" && <span className="text-xs text-muted-foreground">{t("toolbar.milestoneOnly")}</span>}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {statusActive && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="sm" aria-label={t("toolbar.filterMode")} className="kh-board-mode-trigger text-[13px] font-semibold">
              {t(`toolbar.mode.${state.filterMode}`)}
              <ChevronDownIcon className="size-4 opacity-50" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuRadioGroup value={state.filterMode} onValueChange={(mode) => onChange({ ...state, filterMode: mode as BoardFilterMode })}>
              {BOARD_FILTER_MODES.map((mode) => (
                <DropdownMenuRadioItem key={mode} value={mode}>
                  {t(`toolbar.mode.${mode}`)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <FilterChip active={state.humanOnly} onClick={() => onChange({ ...state, humanOnly: !state.humanOnly })}>
        {t("toolbar.humanOnly")}
      </FilterChip>
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
            className="kh-sort-direction"
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
