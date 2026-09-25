import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { Health } from "@kanban-hub/core/schema";
import { formatActorLabel } from "@/lib/actor";
import { formatRelative } from "@/lib/time";
import { cn } from "@/lib/utils";
import { formatLocationLine } from "@/lib/location";
import type { ProjectCardView } from "@/server/views/overview";
import { looseTranslator } from "./loose-translator";
import "./overview.css";
import { ProgressBar } from "./progress-bar";

/** 健康度徽标的颜色：语义色，来自 tokens.css 的 --health-*，与项目页头部同一套 */
const HEALTH_BG_CLASS: Record<Health, string> = {
  on_track: "bg-health-on-track",
  at_risk: "bg-health-at-risk",
  blocked: "bg-health-blocked",
};

/** 卡片的不对称圆角按卡片序号循环，只在主题 B 生效（overview.css），主题 A 下四个值都等于 --radius */
const RADIUS_CLASSES = ["kh-radius-a", "kh-radius-b", "kh-radius-c", "kh-radius-d"];

/**
 * 一张项目卡片：周期、健康度、焦点、进度、最近活动、主位置、停滞标记。
 * 归档的项目整体淡化显示（`opacity`），点击进入 `/p/<id>`。`index` 只用来在主题 B 下循环纸色
 * 和圆角（`data-tone`，见 overview.css），不影响数据或排序。
 */
export async function ProjectCard({ project, now, index }: { project: ProjectCardView; now: Date; index: number }) {
  const t = await getTranslations("overview");
  const tc = await getTranslations("common");
  const te = looseTranslator(await getTranslations("enums"));
  const tev = looseTranslator(await getTranslations("events"));
  const archived = project.cycle === "archived";
  const tone = index % 4;

  return (
    <Link
      href={`/p/${project.id}`}
      data-tone={tone}
      className={cn(
        "kh-overview-card flex flex-col gap-3 rounded-md border bg-card p-4.5 shadow-[var(--shadow-raised)] transition-transform hover:-translate-y-0.5",
        RADIUS_CLASSES[tone],
        archived && "opacity-60",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="break-all text-lg font-bold">{project.name}</span>
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

      <p className="kh-overview-divider min-h-[1.25rem] border-t border-border/60 pt-2 text-xs font-medium break-all text-muted-foreground">
        {project.lastEvent ? (
          <>
            {tev(project.lastEvent.description.key, project.lastEvent.description.values)}
            {" · "}
            {formatActorLabel(project.lastEvent.actor, (primary, machine) => tc("actor.withMachine", { primary, machine }))}
            {" · "}
            {formatRelative(project.lastEvent.ts, now)}
          </>
        ) : (
          t("projects.noActivity")
        )}
      </p>

      {project.location && (
        <p className="kh-overview-divider kh-num border-t border-border/60 pt-2 text-[11px] font-medium break-all text-muted-foreground">
          {formatLocationLine(project.location, (value) => t("projects.syncedAt", { value }))}
        </p>
      )}

      {project.stale && (
        <span className="mt-auto inline-flex w-fit items-center self-start rounded-sm border border-stale/60 bg-stale/10 px-2.5 py-0.5 text-[11px] font-bold text-stale">
          {t("projects.stale", { days: project.stale.days })}
        </span>
      )}
    </Link>
  );
}
