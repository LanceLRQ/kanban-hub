import { Suspense } from "react";
import { notFound } from "next/navigation";
import { pageServices } from "@/server/web/services";
import { buildBoardView } from "@/server/views/board";
import { Board } from "@/components/board/board";

/** 项目看板：容器分区与任务；`?task=<任务ID>` 打开该任务的侧栏 */
export default async function BoardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const services = pageServices();
  const view = buildBoardView(services, id, services.now());
  if (!view) notFound();

  // Board 读取 URL 查询参数（useSearchParams），按 Next 的要求放在 Suspense 边界里
  return (
    <Suspense>
      <Board view={view} />
    </Suspense>
  );
}
