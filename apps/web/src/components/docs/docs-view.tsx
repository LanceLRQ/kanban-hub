import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { DocLinkCtx } from "@/lib/doc-links";
import { docPageHref, rawFileHref } from "@/lib/doc-url";
import type { DocsView as DocsViewData } from "@/server/views/docs";
import { DocTreeView } from "./doc-tree-view";
import { DocFilePanel } from "./doc-file-panel";
import { DocSidebarPanel } from "./doc-sidebar-panel";
import "./docs.css";

interface DocsViewProps {
  projectId: string;
  view: DocsViewData;
}

/** 项目文档视图：左栏文件树 + 最近更新，右栏当前文件的路径与正文（机器切换在标签栏右侧，见 DocsMachinePicker） */
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
    <div className="kh-docs-grid grid gap-5 md:grid-cols-[280px_minmax(0,1fr)]">
      {/* 宽屏下左栏吸顶，高度不超过视口：文件树占剩余高度、最近更新固定高度，都在面板内滚动 */}
      <aside className="kh-docs-sidebar flex flex-col gap-3 md:sticky md:top-4 md:max-h-[calc(100dvh-2rem)] md:self-start">
        <DocSidebarPanel
          title={t("sidebar.treeTitle")}
          className="kh-doc-tree-box md:min-h-0"
          bodyClassName="max-h-[50vh] md:max-h-none md:flex-1"
          activeKey={currentPath}
        >
          <DocTreeView projectId={projectId} machineId={selectedMachine?.id} nodes={view.tree} currentPath={currentPath} />
        </DocSidebarPanel>

        <DocSidebarPanel title={t("sidebar.recentTitle")} className="kh-doc-recent-box shrink-0" bodyClassName="max-h-56">
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
        </DocSidebarPanel>
      </aside>

      <article className="kh-doc-article min-w-0 rounded-md border border-border bg-card">
        <div className="kh-doc-path border-b border-border px-4 py-2 font-mono text-xs text-muted-foreground">
          {view.file?.path ?? t("noFileSelected")}
          {selectedMachine && ` · ${selectedMachine.name}`}
        </div>
        <DocFilePanel file={view.file} machineName={selectedMachine?.name ?? ""} ctx={ctx} />
      </article>
    </div>
  );
}
