import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { cn } from "@/lib/utils";
import type { DocLinkCtx } from "@/lib/doc-links";
import { docPageHref, rawFileHref } from "@/lib/doc-url";
import type { DocsView as DocsViewData } from "@/server/views/docs";
import { DocTreeView } from "./doc-tree-view";
import { DocFilePanel } from "./doc-file-panel";
import "./docs.css";

interface DocsViewProps {
  projectId: string;
  view: DocsViewData;
}

/** 项目文档视图：左栏机器切换 + 文件树 + 最近更新，右栏当前文件的路径与正文 */
export async function DocsView({ projectId, view }: DocsViewProps) {
  const t = await getTranslations("docs");

  if (view.emptyReason === "no-sync") {
    return (
      <div className="kh-docs-empty flex flex-col items-center gap-2 rounded-md border border-border bg-card p-10 text-center">
        <p className="text-sm font-medium">{t("empty.noSync")}</p>
        <p className="font-mono text-xs text-muted-foreground">{t("empty.noSyncHint")}</p>
      </div>
    );
  }

  const selectedMachine = view.machines.find((m) => m.selected) ?? null;
  const currentPath = view.file?.exists ? view.file.path : null;

  const known = new Set(view.filePaths);
  const ctx: DocLinkCtx = {
    exists: (p) => known.has(p),
    docHref: (p, hash) => docPageHref(projectId, p, { machineId: selectedMachine?.id, hash }),
    rawHref: (p) => rawFileHref(view.rawToken!.token, p),
  };

  return (
    <div className="kh-docs-grid grid gap-5 md:grid-cols-[280px_1fr]">
      <aside className="kh-docs-sidebar flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {view.machines.map((m) => (
            <Link
              key={m.id}
              href={docPageHref(projectId, view.file?.path, { machineId: m.id })}
              data-active={m.selected ? "true" : undefined}
              className={cn(
                "kh-doc-machine-chip rounded-sm border border-border px-2 py-1 font-mono text-xs",
                m.selected ? "bg-secondary text-secondary-foreground" : "bg-card text-foreground hover:bg-accent",
              )}
            >
              {m.name}
            </Link>
          ))}
          {selectedMachine?.lastSyncAtLabel && (
            <span className="font-mono text-xs text-muted-foreground">{selectedMachine.lastSyncAtLabel}</span>
          )}
        </div>

        <div className="kh-doc-tree-box rounded-md border border-border bg-card p-2">
          <div className="kh-doc-panel-head">{t("sidebar.treeTitle")}</div>
          <DocTreeView nodes={view.tree} currentPath={currentPath} hrefFor={(p) => docPageHref(projectId, p, { machineId: selectedMachine?.id })} />
        </div>

        <div className="kh-doc-recent-box rounded-md border border-border bg-card p-2">
          <div className="kh-doc-panel-head">{t("sidebar.recentTitle")}</div>
          {view.recent.length === 0 ? (
            <p className="px-2 py-1 text-xs text-muted-foreground">{t("sidebar.recentEmpty")}</p>
          ) : (
            <ul className="flex flex-col text-sm">
              {view.recent.map((r) => (
                <li key={r.path}>
                  <Link
                    href={docPageHref(projectId, r.path, { machineId: selectedMachine?.id })}
                    className="kh-doc-recent-item flex items-center justify-between gap-2 rounded-sm px-2 py-1 hover:bg-accent"
                  >
                    <span className="truncate font-mono text-xs">{r.path}</span>
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">{r.changedAtLabel}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      <article className="kh-doc-article rounded-md border border-border bg-card">
        <div className="kh-doc-path border-b border-border px-4 py-2 font-mono text-xs text-muted-foreground">
          {view.file?.path ?? t("noFileSelected")}
          {selectedMachine && ` · ${selectedMachine.name}`}
        </div>
        <DocFilePanel file={view.file} machineName={selectedMachine?.name ?? ""} ctx={ctx} />
      </article>
    </div>
  );
}
