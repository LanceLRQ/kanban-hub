import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { Health } from "@kanban-hub/core/schema";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import type { ProjectHeaderView } from "@/server/views/project-header";

/** 健康度徽标的颜色：语义色，来自 tokens.css 的 --health-*，两套主题各自取值 */
const HEALTH_BG_CLASS: Record<Health, string> = {
  on_track: "bg-health-on-track",
  at_risk: "bg-health-at-risk",
  blocked: "bg-health-blocked",
};

/**
 * 项目页头部（只读显示）：返回入口、项目名、周期、健康度、焦点、主位置摘要。
 * `.kh-project-header`/`.kh-project-header-divider`/`.kh-health-badge`/`.kh-health-icon`
 * 是主题相关的样式钩子（见 globals.css）：主题 B 用不对称圆角、虚线分隔线、描边徽标 + 圆点，
 * 主题 A 保留实心圆角卡片、实线分隔线、实心徽标 + 对勾方框，组件本身不分叉。
 */
export async function ProjectHeader({ project }: { project: ProjectHeaderView }) {
  const t = await getTranslations("common");
  const te = await getTranslations("enums");

  return (
    <section className="kh-project-header rounded-md border bg-card px-6 py-5 shadow-[var(--shadow-raised)]">
      <div className="flex flex-wrap items-center gap-4">
        <Link href="/" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
          &larr; {t("projectHeader.back")}
        </Link>
        <h1 className="text-[26px] tracking-tight">{project.name}</h1>
        <div className="flex items-center gap-2.5">
          <span className="inline-flex items-center rounded-sm border bg-card px-2.5 py-0.5 text-xs font-bold">
            {te(`cycle.${project.cycle}`)}
          </span>
          <span className={cn("kh-health-badge inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-0.5 text-xs font-bold", HEALTH_BG_CLASS[project.health])}>
            <span className={cn("kh-health-icon", HEALTH_BG_CLASS[project.health])} aria-hidden="true" />
            {te(`health.${project.health}`)}
          </span>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2.5">
        <span className="text-[11px] font-bold tracking-[0.14em] text-muted-foreground">{t("projectHeader.focus")}</span>
        <b className="text-base font-bold">{project.focus !== "" ? project.focus : t("projectHeader.focusEmpty")}</b>
      </div>
      {project.location && (
        <p className="kh-project-header-divider kh-num mt-3 border-t pt-2.5 text-xs font-medium text-muted-foreground">
          {formatLocationLine(project.location, (value) => t("projectHeader.syncedAt", { value }))}
        </p>
      )}
    </section>
  );
}

function formatLocationLine(location: NonNullable<ProjectHeaderView["location"]>, formatSyncedAt: (value: string) => string): string {
  const parts = [`${location.machineName}:${location.path}`];
  if (location.branch !== null) parts.push(location.branch);
  if (location.ahead !== null && location.behind !== null) parts.push(`↑${location.ahead} ↓${location.behind}`);
  if (location.dirtyCount !== null) parts.push(`dirty ${location.dirtyCount}`);
  if (location.syncedAt !== null) parts.push(formatSyncedAt(location.syncedAt));
  return parts.join(" · ");
}
