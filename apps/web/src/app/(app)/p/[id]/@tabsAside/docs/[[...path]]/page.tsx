import { authedPageServices } from "@/server/web/services";
import { buildDocsView } from "@/server/views/docs";
import { DocsMachinePicker } from "@/components/docs/docs-machine-picker";
import { decodeDocPathParam } from "@/lib/doc-url";

/** 文档标签：标签栏右侧放机器切换（只取机器列表，不读文件内容） */
export default async function DocsTabsAside({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; path?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id, path } = await params;
  const sp = await searchParams;
  const { services } = await authedPageServices();

  const machineId = typeof sp.m === "string" ? sp.m : undefined;
  const view = await buildDocsView(services, id, { machineId, withFile: false }, services.now());
  if (!view) return null;

  return <DocsMachinePicker projectId={id} machines={view.machines} path={decodeDocPathParam(path)} />;
}
