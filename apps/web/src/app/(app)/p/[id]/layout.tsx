import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { authedPageServices } from "@/server/web/services";
import { buildProjectHeader } from "@/server/views/project-header";
import { ProjectEditDialog } from "@/components/project/project-edit-dialog";
import { ProjectHeader } from "@/components/project/project-header";
import { PinnedProjectBar } from "@/components/project/pinned-project-bar";
import { ProjectTabs } from "@/components/project/project-tabs";

/**
 * 项目页框架：头部（带“编辑”入口）+ 标签栏；项目不存在时 404。
 * 头部包在悬浮顶栏（PinnedProjectBar）里：下滑、头部卡片滚出视口后顶栏出现，滚回去就收起。
 * 标签栏右侧是并行路由插槽 `@tabsAside`，由各子页决定放什么（目前只有文档页放机器切换）。
 */
export default async function ProjectLayout({
  children,
  tabsAside,
  params,
}: {
  children: ReactNode;
  tabsAside: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { services } = await authedPageServices();
  const project = buildProjectHeader(services, id, services.now());
  const stored = services.store.getProject(id);
  if (!project || !stored) notFound();

  return (
    <div className="flex flex-col gap-4">
      <PinnedProjectBar project={{ name: project.name, cycle: project.cycle, health: project.health }}>
        <ProjectHeader
          project={project}
          actions={
            <ProjectEditDialog
              project={{
                id: stored.id,
                name: stored.name,
                description: stored.description,
                cycle: stored.cycle,
                health: stored.health,
                focus: stored.focus,
                version: stored.version,
              }}
            />
          }
        />
      </PinnedProjectBar>
      <div className="kh-project-tabs-row flex flex-wrap items-center justify-between gap-3">
        <ProjectTabs projectId={project.id} />
        {tabsAside}
      </div>
      {children}
    </div>
  );
}
