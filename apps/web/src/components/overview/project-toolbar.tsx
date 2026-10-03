"use client";

import { useTranslations } from "next-intl";
import { CYCLES, HEALTHS, type Cycle, type Health } from "@kanban-hub/core/schema";
import { FilterChip } from "@/components/filters/filter-chip";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  PROGRESS_BUCKETS,
  PROJECT_SORTS,
  effectiveSelection,
  isDefaultProjectsView,
  type ProgressBucket,
  type ProjectSort,
  type ProjectsViewState,
} from "@/lib/project-filter";
import { looseTranslator } from "./loose-translator";

interface ProjectToolbarProps {
  state: ProjectsViewState;
  onChange: (next: ProjectsViewState) => void;
  onReset: () => void;
}

/** 多选切换一项；没选任何项或全选时存空数组（二者等价） */
function toggled<T>(selected: ReadonlySet<T>, all: readonly T[], value: T): T[] {
  const next = new Set(selected);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next.size === 0 || next.size === all.length ? [] : all.filter((v) => next.has(v));
}

/**
 * 项目列表的筛选与排序工具栏：周期多选、健康度多选、进度单选、排序下拉、方向、重置（仅偏离默认时）。
 * 版式与看板工具栏一致，标签用同一个 FilterChip。
 */
export function ProjectToolbar({ state, onChange, onReset }: ProjectToolbarProps) {
  const t = useTranslations("overview");
  const te = looseTranslator(useTranslations("enums"));
  const cycles = effectiveSelection(state.cycles, CYCLES);
  const healths = effectiveSelection(state.healths, HEALTHS);

  return (
    <div role="group" aria-label={t("projects.toolbar.ariaLabel")} className="kh-projects-toolbar flex flex-wrap items-center gap-x-4 gap-y-2.5">
      <div role="group" aria-label={t("projects.toolbar.cycleGroup")} className="flex flex-wrap items-center gap-2">
        {CYCLES.map((cycle: Cycle) => (
          <FilterChip key={cycle} active={cycles.has(cycle)} onClick={() => onChange({ ...state, cycles: toggled(cycles, CYCLES, cycle) })}>
            {te(`cycle.${cycle}`)}
          </FilterChip>
        ))}
      </div>
      <div role="group" aria-label={t("projects.toolbar.healthGroup")} className="flex flex-wrap items-center gap-2">
        {HEALTHS.map((health: Health) => (
          <FilterChip key={health} active={healths.has(health)} onClick={() => onChange({ ...state, healths: toggled(healths, HEALTHS, health) })}>
            {te(`health.${health}`)}
          </FilterChip>
        ))}
      </div>
      <div role="group" aria-label={t("projects.toolbar.progressLabel")} className="flex flex-wrap items-center gap-2">
        {PROGRESS_BUCKETS.map((bucket: ProgressBucket) => (
          <FilterChip key={bucket} active={state.progress === bucket} onClick={() => onChange({ ...state, progress: bucket })}>
            {t(`projects.toolbar.progress.${bucket}`)}
          </FilterChip>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={state.sort} onValueChange={(sort) => onChange({ ...state, sort: sort as ProjectSort })}>
          <SelectTrigger size="sm" aria-label={t("projects.toolbar.sortLabel")} className="kh-projects-sort bg-card text-[13px] font-semibold">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROJECT_SORTS.map((sort) => (
              <SelectItem key={sort} value={sort}>
                {t(`projects.toolbar.sort.${sort}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="projects-direction"
          onClick={() => onChange({ ...state, direction: state.direction === "desc" ? "asc" : "desc" })}
          className="kh-filter-chip"
        >
          {t(`projects.toolbar.direction.${state.sort}.${state.direction}`)}
        </Button>
      </div>
      {!isDefaultProjectsView(state) && (
        <Button type="button" variant="ghost" size="sm" onClick={onReset} className="kh-projects-reset">
          {t("projects.toolbar.reset")}
        </Button>
      )}
    </div>
  );
}
