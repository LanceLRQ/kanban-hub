import { getTranslations } from "next-intl/server";
import { serverTimeZone } from "@/lib/time";
import type { BackupFileInfo } from "@/server/store/backup";
import { BackupCreateForm } from "./backup-create-form";
import { BackupList } from "./backup-list";
import { SectionRow } from "./section-card";

/** 加密备份区块：上面是创建表单（进行中禁用并提示），下面是备份列表，每行可下载 */
export async function BackupSection({ backups, now }: { backups: BackupFileInfo[]; now: Date }) {
  const t = await getTranslations("settings");

  return (
    <>
      <SectionRow label={t("backup.create")}>
        <BackupCreateForm />
      </SectionRow>
      <BackupList
        backups={backups}
        now={now}
        timeZone={serverTimeZone()}
        listLabel={t("backup.listLabel")}
        emptyLabel={t("backup.empty")}
        downloadLabel={t("backup.download")}
      />
    </>
  );
}
