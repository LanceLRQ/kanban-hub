import { getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/button";

/** 导出的下载地址：download=1 让服务端带上 Content-Disposition，浏览器按附件保存 */
export function exportHref(projectId: string, format: "yaml" | "md"): string {
  return `/api/v1/projects/${encodeURIComponent(projectId)}/export?format=${format}&download=1`;
}

/** 项目设置页的“导出 YAML”“导出 Markdown”：普通链接，靠网页会话鉴权 */
export async function ExportLinks({ projectId }: { projectId: string }) {
  const t = await getTranslations("projectSettings");

  return (
    <>
      <Button asChild variant="outline" size="sm">
        <a href={exportHref(projectId, "yaml")} download>
          {t("exportYaml")}
        </a>
      </Button>
      <Button asChild variant="outline" size="sm">
        <a href={exportHref(projectId, "md")} download>
          {t("exportMarkdown")}
        </a>
      </Button>
    </>
  );
}
