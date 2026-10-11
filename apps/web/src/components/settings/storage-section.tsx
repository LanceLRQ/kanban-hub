import { getTranslations } from "next-intl/server";
import { formatBytes } from "@/lib/bytes";
import type { StorageCategoryView, StorageView } from "@/server/views/settings";
import { SectionRow } from "./section-card";

/**
 * 设置页的存储占用面板：数据目录的分项小计（看板与事件数据、文档快照与清单、凭据、
 * git 历史、其他）加合计，以及各项目的明细表。数字走等宽字体（.kh-num），大小与
 * 文件数怎么显示在这里定，视图层只给原始字节数。
 */
export async function StorageSection({ storage }: { storage: StorageView }) {
  const t = await getTranslations("settings");

  const sizeOf = (entry: StorageCategoryView) => (
    <span className="flex flex-wrap items-baseline gap-x-2">
      <span className="kh-num font-bold">{formatBytes(entry.bytes)}</span>
      {entry.files > 0 && <span className="text-xs text-muted-foreground">{t("storage.fileCount", { count: entry.files })}</span>}
    </span>
  );

  const boardTotal = storage.projects.reduce((sum, p) => sum + p.board.bytes, 0);
  const docsTotal = storage.projects.reduce((sum, p) => sum + p.docs.bytes, 0);

  return (
    <>
      <SectionRow label={t("storage.board")}>{sizeOf(storage.board)}</SectionRow>
      <SectionRow label={t("storage.docs")}>{sizeOf(storage.docs)}</SectionRow>
      <SectionRow label={t("storage.auth")}>{sizeOf(storage.auth)}</SectionRow>
      <SectionRow label={t("storage.git")}>{sizeOf(storage.git)}</SectionRow>
      <SectionRow label={t("storage.other")}>{sizeOf(storage.other)}</SectionRow>
      <SectionRow label={t("storage.total")}>
        <span className="kh-num text-base font-extrabold">{formatBytes(storage.totalBytes)}</span>
      </SectionRow>
      <SectionRow label={t("storage.byProject")}>
        {storage.projects.length === 0 ? (
          <p className="text-muted-foreground">{t("storage.noProjects")}</p>
        ) : (
          <table className="w-full max-w-xl text-left text-sm">
            <thead>
              <tr className="text-xs font-bold text-muted-foreground">
                <th scope="col" className="pb-1.5 pr-4 font-bold">{t("storage.projectColumn")}</th>
                <th scope="col" className="pb-1.5 pr-4 text-right font-bold">{t("storage.boardColumn")}</th>
                <th scope="col" className="pb-1.5 text-right font-bold">{t("storage.docsColumn")}</th>
              </tr>
            </thead>
            <tbody>
              {storage.projects.map((p) => (
                <tr key={p.projectId} className="border-t [border-top-color:var(--border-soft)]">
                  <td className="py-1.5 pr-4">{p.name}</td>
                  <td className="kh-num py-1.5 pr-4 text-right">{formatBytes(p.board.bytes)}</td>
                  <td className="kh-num py-1.5 text-right">{formatBytes(p.docs.bytes)}</td>
                </tr>
              ))}
              <tr className="border-t [border-top-color:var(--border)]">
                <td className="py-1.5 pr-4 font-bold">{t("storage.total")}</td>
                <td className="kh-num py-1.5 pr-4 text-right font-bold">{formatBytes(boardTotal)}</td>
                <td className="kh-num py-1.5 text-right font-bold">{formatBytes(docsTotal)}</td>
              </tr>
            </tbody>
          </table>
        )}
      </SectionRow>
    </>
  );
}
