import { stringify } from "yaml";
import type { Board, Project } from "@kanban-hub/core/schema";
import { buildExportDoc, renderBoardMarkdown } from "@kanban-hub/core/transfer";
import { serverTimeZone } from "@/lib/time";
import { ApiError } from "@/server/api/errors";
import { requireBoard, requireProject } from "@/server/api/project-view";
import { apiRoute, type AnyRouteArgs } from "@/server/api/route";

const FORMATS = {
  yaml: { contentType: "application/yaml; charset=utf-8", extension: "yaml" },
  md: { contentType: "text/markdown; charset=utf-8", extension: "md" },
} as const;

type ExportFormat = keyof typeof FORMATS;

function readFormat(value: string | null): ExportFormat {
  if (value === "yaml" || value === "md") return value;
  throw new ApiError("invalid", "format 必须是 yaml 或 md");
}

/**
 * 下载用的 Content-Disposition。项目名可以含换行、引号、斜杠，原样放进响应头会让构造响应时抛错，
 * 所以：filename* 按 RFC 5987 做 UTF-8 百分号编码（attr-char 之外的字符全部编码）；
 * 给不认识 filename* 的客户端的 ASCII 兜底，把 [A-Za-z0-9._-] 以外的字符都换成 _。
 */
function attachmentDisposition(fileName: string): string {
  // 孤立的代理项会让 encodeURIComponent 抛错，先换成替换字符
  const name = fileName.toWellFormed();
  const fallback = name.replace(/[^A-Za-z0-9._-]/g, "_");
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export const GET = apiRoute({ auth: "any" }, async ({ req, params, services }: AnyRouteArgs<{ id: string }>) => {
  const search = new URL(req.url).searchParams;
  const format = readFormat(search.get("format"));
  // 导出只读取，不修改；两个函数的参数类型不带 readonly，这里只做类型上的转换
  const project = requireProject(services.store, params.id) as Project;
  const board = requireBoard(services.store, params.id) as Board;

  let body: string;
  if (format === "yaml") {
    const logs = await services.store.readProjectLogs(params.id);
    body = stringify(buildExportDoc(project, board, logs), { lineWidth: 0, aliasDuplicateObjects: false });
  } else {
    body = renderBoardMarkdown(project, board, { now: services.now(), timeZone: serverTimeZone() });
  }

  const headers = new Headers({ "Content-Type": FORMATS[format].contentType, "Cache-Control": "no-store" });
  if (search.get("download") === "1") {
    headers.set("Content-Disposition", attachmentDisposition(`${project.name}-kanban.${FORMATS[format].extension}`));
  }
  return new Response(body, { headers });
});
