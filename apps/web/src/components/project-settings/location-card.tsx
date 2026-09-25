import { getTranslations } from "next-intl/server";
import type { ProjectSettingsLocationView } from "@/server/views/project-settings";
import { SectionRow } from "@/components/settings/section-card";
import { formatBytes } from "./format-bytes";

function formatSyncScope(sync: NonNullable<ProjectSettingsLocationView["sync"]>): string {
  const parts = [...sync.include, ...sync.exclude.map((p) => `!${p}`), `<= ${formatBytes(sync.maxFileSize)}`];
  return parts.join(" · ");
}

/** 一个位置：机器名、路径、同步范围、git 状态（缺失时省略）、最后同步、跳过的文件 */
export async function LocationCard({ location, index }: { location: ProjectSettingsLocationView; index: number }) {
  const t = await getTranslations("projectSettings");

  const hasGit = location.branch !== null;
  const gitParts = [
    location.branch,
    location.ahead !== null && location.behind !== null ? `↑${location.ahead} ↓${location.behind}` : null,
    location.dirtyCount !== null ? t("location.dirty", { count: location.dirtyCount }) : null,
    location.headAt !== null ? t("location.head", { value: location.headAt }) : null,
  ].filter((v): v is string => v !== null);

  return (
    <>
      <SectionRow label={t("location.title", { index })}>
        <span className="font-bold">{location.machineName}</span>
        <span className="kh-num ml-2 text-muted-foreground">{location.path}</span>
      </SectionRow>
      <SectionRow label={t("location.syncScope")}>
        {location.sync === null ? (
          <span className="text-muted-foreground">{t("location.syncScopeEmpty")}</span>
        ) : (
          <span className="kh-num">{formatSyncScope(location.sync)}</span>
        )}
      </SectionRow>
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
