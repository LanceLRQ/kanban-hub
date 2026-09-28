import { notFound } from "next/navigation";
import { authedPageServices } from "@/server/web/services";
import { buildDocsView } from "@/server/views/docs";
import { DocsView } from "@/components/docs/docs-view";

/** 项目文档：选机器、看文件树与最近更新、读渲染后的 Markdown、打开原文件 */
export default async function ProjectDocsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; path?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id, path } = await params;
  const sp = await searchParams;
  const { services } = await authedPageServices();

  const machineParam = sp.m;
  const machineId = typeof machineParam === "string" ? machineParam : undefined;

  const view = await buildDocsView(services, id, { machineId, path: path?.join("/") }, services.now());
  if (!view) notFound();

  return <DocsView projectId={id} view={view} />;
}
