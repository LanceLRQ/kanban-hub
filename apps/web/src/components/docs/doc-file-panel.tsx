import { getTranslations } from "next-intl/server";
import { ExternalLinkIcon } from "lucide-react";
import type { DocsFileView } from "@/server/views/docs";
import type { DocLinkCtx } from "@/lib/doc-links";
import { wrapAsFencedCode } from "@/lib/highlight-text";
import { DocMarkdown } from "./doc-markdown";

/** 右栏正文：按 file.kind 决定显示方式 */
export async function DocFilePanel({ file, machineName, ctx }: { file: DocsFileView | null; machineName: string; ctx: DocLinkCtx }) {
  const t = await getTranslations("docs");

  if (file === null) {
    return <p className="p-6 text-sm text-muted-foreground">{t("noFileSelected")}</p>;
  }

  if (!file.exists) {
    return <p className="p-6 text-sm text-muted-foreground">{t("fileMissing", { machine: machineName })}</p>;
  }

  if ((file.kind === "markdown" || file.kind === "text") && file.content !== null) {
    const markdown = file.kind === "markdown" ? file.content : wrapAsFencedCode(file.content, file.path);
    return <DocMarkdown markdown={markdown} currentPath={file.path} ctx={ctx} />;
  }

  if (file.kind === "image") {
    return (
      <div className="flex flex-col gap-3 p-6">
        {/* eslint-disable-next-line @next/next/no-img-element -- /raw 内容不经过 Next 的图片优化管线 */}
        <img src={file.rawHref} alt={file.path} className="max-w-full rounded-sm border border-border" />
      </div>
    );
  }

  const hint = file.kind === "too-large" ? t("file.tooLarge") : file.kind === "binary" ? t("file.binary") : t("file.unsupportedHint");

  return (
    <div className="flex flex-col gap-3 p-6 text-sm text-muted-foreground">
      <p>{hint}</p>
      <a href={file.rawHref} target="_blank" rel="noopener noreferrer" className="inline-flex w-fit items-center gap-1.5 text-foreground hover:underline">
        <ExternalLinkIcon className="size-4" />
        {file.kind === "html" || file.kind === "svg" || file.kind === "pdf" ? t("file.openInNewTab") : t("file.openRaw")}
      </a>
    </div>
  );
}
