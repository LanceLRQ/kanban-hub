import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { OverviewView } from "@/server/views/overview";
import { ProjectCard } from "./project-card";
import { ProjectGrid } from "./project-grid";
import { SectionHead } from "./section-head";

/**
 * 项目列表页的区块：先在服务端把每张卡片渲染成节点，再交给客户端的 ProjectGrid 做筛选与排序；
 * 没有项目时显示提示和去接入页的链接，不显示工具栏。
 */
export async function ProjectSection({ view, now }: { view: OverviewView; now: Date }) {
  const t = await getTranslations("overview");

  if (view.projects.length === 0) {
    return (
      <section>
        <SectionHead title={t("projects.heading")} count={0} tag="projects" />
        <NoProjectsHint />
      </section>
    );
  }

  const items = view.projects.map((project) => ({
    meta: {
      id: project.id,
      cycle: project.cycle,
      health: project.health,
      progress: project.progress,
      createdAt: project.createdAt,
      lastEventAt: project.lastEventAt,
    },
    node: <ProjectCard key={project.id} project={project} now={now} />,
  }));

  return <ProjectGrid items={items} title={t("projects.heading")} tag="projects" />;
}

/** 还没有任何项目时的提示和去接入页的链接；项目列表页和首页共用 */
export async function NoProjectsHint() {
  const t = await getTranslations("overview");
  return (
    <div className="kh-radius-d rounded-md border border-dashed bg-card px-6 py-10 text-center">
      <p className="text-base font-bold">{t("projects.empty.heading")}</p>
      <p className="mt-1.5 text-sm text-muted-foreground">{t("projects.empty.body")}</p>
      <Link href="/setup" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "mt-4")}>
        {t("projects.empty.cta")}
      </Link>
    </div>
  );
}
