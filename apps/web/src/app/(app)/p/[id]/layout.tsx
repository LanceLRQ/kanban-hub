import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { pageServices } from "@/server/web/services";
import { buildProjectHeader } from "@/server/views/project-header";
import { ProjectEditDialog } from "@/components/project/project-edit-dialog";
import { ProjectHeader } from "@/components/project/project-header";
import { ProjectTabs } from "@/components/project/project-tabs";

/** 项目页框架：头部（带“编辑”入口）+ 标签栏；项目不存在时 404 */
export default async function ProjectLayout({ children, params }: { children: ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  const services = pageServices();
  const project = buildProjectHeader(services, id, services.now());
  const stored = services.store.getProject(id);
  if (!project || !stored) notFound();

  return (
    <div className="flex flex-col gap-4">
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
      <ProjectTabs projectId={project.id} />
      {children}
    </div>
  );
}
