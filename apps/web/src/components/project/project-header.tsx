import type { ReactNode } from "react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { HEALTH_TONE } from "@/lib/solid-tone";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { formatLocationLine } from "@/lib/location";
import type { ProjectHeaderView } from "@/server/views/project-header";

/**
 * 项目页头部（只读显示）：返回入口、项目名、周期、健康度、焦点、主位置摘要。
 * `.kh-project-header`/`.kh-project-header-divider` 是主题相关的样式钩子（见 globals.css）：
 * 主题 B 用不对称圆角、虚线分隔线，主题 A 保留实心圆角卡片、实线分隔线，组件本身不分叉。
 * 健康度徽标两套主题都是实心底色 + 白字（lib/solid-tone.ts）。
 * `actions` 放在第一行最右侧（项目页放“编辑”按钮）。
 */
export async function ProjectHeader({ project, actions }: { project: ProjectHeaderView; actions?: ReactNode }) {
  const t = await getTranslations("common");
  const te = await getTranslations("enums");

  return (
    <section className="kh-project-header rounded-md border bg-card px-6 py-5 shadow-[var(--shadow-raised)]">
      <div className="flex flex-wrap items-center gap-4">
        <Link href="/projects" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
          &larr; {t("projectHeader.back")}
        </Link>
        <h1 className="text-[26px] tracking-tight">{project.name}</h1>
        <div className="flex items-center gap-2.5">
          <span className="inline-flex items-center rounded-sm border bg-card px-2.5 py-0.5 text-xs font-bold">
            {te(`cycle.${project.cycle}`)}
          </span>
          <span className={cn("kh-health-badge inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-0.5 text-xs font-bold", HEALTH_TONE[project.health])}>
                {te(`health.${project.health}`)}
          </span>
        </div>
        {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
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
