import { getTranslations } from "next-intl/server";
import type { ProjectSettingsLocationView } from "@/server/views/project-settings";
import { SectionRow } from "@/components/settings/section-card";
import { formatBytes } from "./format-bytes";

/** include/exclude 的模式列表；exclude 的每一项前面加 `!` 区分方向。都为空时返回 null（组件按“（无）”显示） */
function formatPatterns(sync: NonNullable<ProjectSettingsLocationView["sync"]>): string | null {
  const parts = [...sync.include, ...sync.exclude.map((p) => `!${p}`)];
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** 一个位置：机器名、路径、同步范围（模式 + 单文件上限分两行）、git 状态（缺失时省略）、最后同步、跳过的文件 */
export async function LocationCard({ location, index }: { location: ProjectSettingsLocationView; index: number }) {
  const t = await getTranslations("projectSettings");

  const hasGit = location.branch !== null;
  const gitParts = [
    location.branch,
    location.ahead !== null && location.behind !== null ? `↑${location.ahead} ↓${location.behind}` : null,
    location.dirtyCount !== null ? t("location.dirty", { count: location.dirtyCount }) : null,
    location.headAt !== null ? t("location.head", { value: location.headAt }) : null,
  ].filter((v): v is string => v !== null);

  const patterns = location.sync === null ? null : formatPatterns(location.sync);

  return (
    <>
      <SectionRow label={t("location.title", { index, machineName: location.machineName })}>
        <span className="kh-num text-muted-foreground">{location.path}</span>
      </SectionRow>
      {location.sync === null ? (
        <SectionRow label={t("location.syncScope")}>
          <span className="text-muted-foreground">{t("location.syncScopeEmpty")}</span>
        </SectionRow>
      ) : (
        <>
          <SectionRow label={t("location.syncScope")}>
            {patterns === null ? <span className="text-muted-foreground">{t("location.syncScopeNone")}</span> : <span className="kh-num">{patterns}</span>}
          </SectionRow>
          <SectionRow label={t("location.maxFileSize")}>
            <span className="kh-num">{formatBytes(location.sync.maxFileSize)}</span>
          </SectionRow>
        </>
      )}
      {hasGit && (
        <SectionRow label={t("location.gitStatus")}>
          <span className="kh-num">{gitParts.join(" · ")}</span>
        </SectionRow>
      )}
      <SectionRow label={t("location.lastSync")}>
        {location.syncedAt === null ? t("location.neverSynced") : location.syncedAt}
      </SectionRow>
      {location.skippedFiles.length > 0 && (
        <SectionRow label={t("location.skippedFiles")}>
          <ul className="flex flex-col gap-0.5">
            {location.skippedFiles.map((file) => (
              <li key={file.path} className="kh-num text-muted-foreground">
                {file.path} · {formatBytes(file.size)}
              </li>
            ))}
          </ul>
        </SectionRow>
      )}
    </>
  );
}
