"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { useLocalView } from "@/lib/client/use-local-view";
import {
  DEFAULT_PROJECTS_VIEW,
  applyProjectsView,
  projectsViewStateSchema,
  type ProjectFilterMeta,
} from "@/lib/project-filter";
import { ProjectToolbar } from "./project-toolbar";
import { SectionHead } from "./section-head";

export interface ProjectGridItem {
  meta: ProjectFilterMeta;
  /** 服务端渲染好的卡片，key 用项目 id */
  node: ReactNode;
}

/**
 * 项目列表的标题行、工具栏和卡片网格。卡片由服务端渲染成节点传进来，这里只负责按本地保存的筛选与排序
 * 决定显示哪些、什么顺序；被隐藏的卡片不渲染。主题 B 的纸色和圆角按卡片在网格里的位置循环
 * （overview.css 的 .kh-project-grid 规则），所以筛选、重排后自动按可见顺序重新着色。
 * 标题旁的计数：有项目被筛掉时显示"可见数 / 总数"，否则只显示总数。
 */
export function ProjectGrid({ items, title, tag }: { items: ProjectGridItem[]; title: string; tag: string }) {
  const t = useTranslations("overview");
  const [view, setView, resetView] = useLocalView("kh-projects-view", projectsViewStateSchema, DEFAULT_PROJECTS_VIEW);

  const visible = applyProjectsView(
    items.map((item) => ({ ...item.meta, node: item.node })),
    view,
  );
  const count = visible.length === items.length ? items.length : `${visible.length} / ${items.length}`;

  return (
    <section>
      <SectionHead title={title} count={count} tag={tag} />
      <div className="mb-5">
        <ProjectToolbar state={view} onChange={setView} onReset={resetView} />
      </div>
      {visible.length === 0 ? (
        <div className="kh-radius-d rounded-md border border-dashed bg-card px-6 py-10 text-center">
          <p className="text-base font-bold">{t("projects.filteredEmpty.heading")}</p>
          <Button type="button" variant="outline" size="sm" onClick={resetView} className="mt-4">
            {t("projects.filteredEmpty.reset")}
          </Button>
        </div>
      ) : (
        <div className="kh-project-grid grid gap-5 sm:grid-cols-2 xl:grid-cols-4 @[100rem]:grid-cols-5 @[120rem]:grid-cols-6">
          {visible.map((item) => item.node)}
        </div>
      )}
    </section>
  );
}
