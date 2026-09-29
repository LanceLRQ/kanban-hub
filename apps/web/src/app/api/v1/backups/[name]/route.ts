import { KhError } from "@kanban-hub/core/errors";
import { apiRoute, type AnyRouteArgs } from "@/server/api/route";
import { BACKUP_FILE_NAME_RE } from "@/server/store/backup";

// 备份文件读取依赖运行期的备份目录，不能在构建期静态化
export const dynamic = "force-dynamic";

/**
 * 下载一份备份。路由处理函数拿到的 params 已解码（URL 里的 ..%2F 到这里就是 ../），
 * 先按约定正则拦下不像备份文件名的名字，再按名字读文件（读取端会再校验一次）。
 * 文件名既然匹配正则，就只含字母数字和 .-_，可以原样放进 Content-Disposition。
 */
export const GET = apiRoute({ auth: "any" }, async ({ params, services }: AnyRouteArgs<{ name: string }>) => {
  if (!BACKUP_FILE_NAME_RE.test(params.name)) {
    throw new KhError("not_found", "备份文件不存在");
  }
  const bytes = await services.store.readBackupFile(params.name);
  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${params.name}"`,
      "Cache-Control": "no-store",
    },
  });
});
