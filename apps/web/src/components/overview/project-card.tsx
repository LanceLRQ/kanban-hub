import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { Health } from "@kanban-hub/core/schema";
import { formatRelative } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { LocationSummary } from "@/lib/location";
import type { ProjectCardView } from "@/server/views/overview";
import { looseTranslator } from "./loose-translator";
import { ProgressBar } from "./progress-bar";

/** 健康度徽标的颜色：语义色，来自 tokens.css 的 --health-*，与项目页头部同一套 */
const HEALTH_BG_CLASS: Record<Health, string> = {
  on_track: "bg-health-on-track",
  at_risk: "bg-health-at-risk",
  blocked: "bg-health-blocked",
};

function formatLocationLine(location: LocationSummary, syncedAtLabel: (value: string) => string): string {
  const parts = [`${location.machineName}:${location.path}`];
  if (location.branch !== null) parts.push(location.branch);
  if (location.ahead !== null && location.behind !== null) parts.push(`↑${location.ahead} ↓${location.behind}`);
  if (location.dirtyCount !== null) parts.push(`dirty ${location.dirtyCount}`);
  if (location.syncedAt !== null) parts.push(syncedAtLabel(location.syncedAt));
  return parts.join(" · ");
}

/**
 * 一张项目卡片：周期、健康度、焦点、进度、最近活动、主位置、停滞标记（细节「项目卡片」）。
 * 归档的项目整体淡化显示（`opacity`），点击进入 `/p/<id>`。
 */
export async function ProjectCard({ project, now }: { project: ProjectCardView; now: Date }) {
  const t = await getTranslations("overview");
  const te = looseTranslator(await getTranslations("enums"));
  const tev = looseTranslator(await getTranslations("events"));
  const archived = project.cycle === "archived";

  return (
    <Link
      href={`/p/${project.id}`}
      className={cn(
        "kh-radius-c flex flex-col gap-3 rounded-md border bg-card p-4.5 shadow-[var(--shadow-raised)] transition-transform hover:-translate-y-0.5",
        archived && "opacity-60",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-lg font-bold">{project.name}</span>
        <span className="inline-flex shrink-0 items-center rounded-sm border bg-card px-2.5 py-0.5 text-xs font-bold">
          {te(`cycle.${project.cycle}`)}
        </span>
      </div>

      <span
        className={cn(
          "kh-health-badge inline-flex w-fit items-center gap-1.5 rounded-sm border px-2.5 py-0.5 text-xs font-bold",
          HEALTH_BG_CLASS[project.health],
        )}
      >
        <span className={cn("kh-health-icon", HEALTH_BG_CLASS[project.health])} aria-hidden="true" />
        {te(`health.${project.health}`)}
      </span>

      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-bold tracking-[0.14em] text-muted-foreground">{t("projects.focusLabel")}</span>
        <p className="text-sm leading-snug font-bold">{project.focus !== "" ? project.focus : t("projects.focusEmpty")}</p>
      </div>

      <div className="flex items-center gap-2.5">
        <ProgressBar done={project.progress.done} total={project.progress.total} />
        <span className="kh-num shrink-0 text-xs font-bold text-muted-foreground">
          {project.progress.done}/{project.progress.total}
        </span>
      </div>

      <p className="min-h-[1.25rem] text-xs font-medium text-muted-foreground">
        {project.lastEvent ? (
          <>
            {tev(project.lastEvent.description.key, project.lastEvent.description.values)}
            {" · "}
            {project.lastEvent.actor.primary}
            {project.lastEvent.actor.secondary !== null ? ` (${project.lastEvent.actor.secondary})` : ""}
            {" · "}
            {formatRelative(project.lastEvent.ts, now)}
          </>
        ) : (
          t("projects.noActivity")
        )}
      </p>

      {project.location && (
        <p className="kh-num border-t border-border/60 pt-2 text-[11px] font-medium text-muted-foreground">
          {formatLocationLine(project.location, (value) => t("projects.syncedAt", { value }))}
        </p>
      )}

      {project.stale && (
        <span className="inline-flex w-fit items-center rounded-sm border border-stale/60 bg-stale/10 px-2.5 py-0.5 text-[11px] font-bold text-stale">
          {t("projects.stale", { days: project.stale.days })}
        </span>
      )}
    </Link>
  );
}
