"use client";

import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import type { TimelineFilterOption, TimelineFilterOptions, TimelineFilters } from "@/server/views/timeline";

/**
 * 时间线的三组筛选（项目、类型、操作者）：点击后用 `router.replace` 把筛选条件写进 URL 查询
 * 参数，服务端按新条件重新渲染第一页。项目内时间线固定本项目，
 * 不显示项目筛选组（`showProjectFilter=false`）。
 */
export function TimelineFilterBar({
  filterOptions,
  filters,
  showProjectFilter,
}: {
  filterOptions: TimelineFilterOptions;
  filters: TimelineFilters;
  showProjectFilter: boolean;
}) {
  const t = useTranslations("timeline");
  const router = useRouter();
  const pathname = usePathname();

  function setFilter(key: "project" | "type" | "actor", value: string | undefined) {
    const params = new URLSearchParams();
    if (key !== "project" && filters.projectId !== undefined && showProjectFilter) params.set("project", filters.projectId);
    if (key !== "type" && filters.group !== undefined) params.set("type", filters.group);
    if (key !== "actor" && filters.actor !== undefined) params.set("actor", filters.actor);
    if (value !== undefined) params.set(key, value);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  }

  return (
    <div className="flex flex-col gap-2.5">
      {showProjectFilter && (
        <FilterRow
          label={t("filters.project")}
          allLabel={t("filters.all")}
          options={filterOptions.projects}
          active={filters.projectId}
          onSelect={(v) => setFilter("project", v)}
        />
      )}
      <FilterRow
        label={t("filters.type")}
        allLabel={t("filters.all")}
        options={filterOptions.groups}
        active={filters.group}
        onSelect={(v) => setFilter("type", v)}
      />
      <FilterRow
        label={t("filters.actor")}
        allLabel={t("filters.all")}
        options={filterOptions.actors}
        active={filters.actor}
        onSelect={(v) => setFilter("actor", v)}
      />
    </div>
  );
}

function FilterRow({
  label,
  allLabel,
  options,
  active,
  onSelect,
}: {
  label: string;
  allLabel: string;
  options: TimelineFilterOption[];
  active: string | undefined;
  onSelect: (value: string | undefined) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-10 shrink-0 text-xs font-bold text-muted-foreground">{label}</span>
      <FilterChip label={allLabel} active={active === undefined} onClick={() => onSelect(undefined)} />
      {options.map((option) => (
        <FilterChip
          key={option.value}
          label={option.label}
          active={active === option.value}
          onClick={() => onSelect(active === option.value ? undefined : option.value)}
        />
      ))}
    </div>
  );
}

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <Button
      type="button"
      variant={active ? "secondary" : "outline"}
      size="sm"
      aria-pressed={active}
      onClick={onClick}
      className="kh-timeline-chip"
    >
      {label}
    </Button>
  );
}
