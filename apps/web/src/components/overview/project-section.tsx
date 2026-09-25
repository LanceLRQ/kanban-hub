import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { OverviewView } from "@/server/views/overview";
import { ProjectCard } from "./project-card";
import { SectionHead } from "./section-head";

/** 总览页“项目”区块：卡片网格；没有项目时显示提示和去接入页的链接（细节「空状态」） */
export async function ProjectSection({ view, now }: { view: OverviewView; now: Date }) {
  const t = await getTranslations("overview");

  return (
    <section>
      <SectionHead no="02" title={t("projects.heading")} count={view.projects.length} tag="projects" />
      {view.projects.length === 0 ? (
        <div className="kh-radius-d rounded-md border border-dashed bg-card px-6 py-10 text-center">
          <p className="text-base font-bold">{t("projects.empty.heading")}</p>
          <p className="mt-1.5 text-sm text-muted-foreground">{t("projects.empty.body")}</p>
          <Link href="/setup" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "mt-4")}>
            {t("projects.empty.cta")}
          </Link>
        </div>
      ) : (
        <div className="grid items-start gap-5 sm:grid-cols-2 xl:grid-cols-4">
          {view.projects.map((project) => (
            <ProjectCard key={project.id} project={project} now={now} />
          ))}
        </div>
      )}
    </section>
  );
}
