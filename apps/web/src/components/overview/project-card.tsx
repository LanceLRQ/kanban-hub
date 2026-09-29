import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { formatActorLabel } from "@/lib/actor";
import { formatRelative } from "@/lib/time";
import { HEALTH_TONE } from "@/lib/solid-tone";
import { cn } from "@/lib/utils";
import { formatLocationParts } from "@/lib/location";
import type { ProjectCardView } from "@/server/views/overview";
import { TruncatedText } from "@/components/truncated-text";
import { looseTranslator } from "./loose-translator";
import "./overview.css";
import { ProgressBar } from "./progress-bar";

/** 卡片的不对称圆角按卡片序号循环，只在主题 B 生效（overview.css），主题 A 下四个值都等于 --radius */
const RADIUS_CLASSES = ["kh-radius-a", "kh-radius-b", "kh-radius-c", "kh-radius-d"];

/**
 * 一张项目卡片：周期、健康度、焦点、进度、最近活动、主位置、停滞标记。每段文字各自限行、超长省略，
 * 被截断的鼠标悬停时显示完整内容（TruncatedText）。
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
  const lastEvent = project.lastEvent;
  const location = project.location ? formatLocationParts(project.location, (value) => t("projects.syncedAt", { value })) : null;

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
        <TruncatedText text={project.name} className="text-lg font-bold" />
        <span className="inline-flex shrink-0 items-center rounded-sm border bg-card px-2.5 py-0.5 text-xs font-bold">
          {te(`cycle.${project.cycle}`)}
        </span>
      </div>

      <span
        className={cn(
          "kh-health-badge inline-flex w-fit items-center gap-1.5 rounded-sm border px-2.5 py-0.5 text-xs font-bold",
          HEALTH_TONE[project.health],
        )}
      >
        {te(`health.${project.health}`)}
      </span>

      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-bold tracking-[0.14em] text-muted-foreground">{t("projects.focusLabel")}</span>
        <TruncatedText text={project.focus !== "" ? project.focus : t("projects.focusEmpty")} lines={2} className="text-sm leading-snug font-bold" />
      </div>

      <div className="flex items-center gap-2.5">
        <ProgressBar done={project.progress.done} total={project.progress.total} />
        <span className="kh-num shrink-0 text-xs font-bold text-muted-foreground">
          {project.progress.done}/{project.progress.total}
        </span>
      </div>

      {/* 最近活动、位置各分两行、各自省略：长描述、长路径不会把时间和同步状态挤掉 */}
      <div className="kh-overview-divider flex min-h-[1.25rem] flex-col gap-0.5 border-t border-border/60 pt-2 text-xs font-medium text-muted-foreground">
        {lastEvent ? (
          <>
            <TruncatedText text={tev(lastEvent.description.key, lastEvent.description.values)} />
            <TruncatedText
              text={`${formatActorLabel(lastEvent.actor, (primary, machine) => tc("actor.withMachine", { primary, machine }))} · ${formatRelative(lastEvent.ts, now)}`}
            />
          </>
        ) : (
          t("projects.noActivity")
        )}
      </div>

      {location && (
        <div className="kh-overview-divider kh-num flex flex-col gap-0.5 border-t border-border/60 pt-2 text-[11px] font-medium text-muted-foreground">
          <TruncatedText text={location.where} />
          {location.status !== null && <TruncatedText text={location.status} />}
        </div>
      )}

      {project.stale && (
        <span className="mt-auto inline-flex w-fit items-center self-start rounded-sm border border-stale/60 bg-stale/10 px-2.5 py-0.5 text-[11px] font-bold text-stale">
          {t("projects.stale", { days: project.stale.days })}
        </span>
      )}
    </Link>
  );
}
