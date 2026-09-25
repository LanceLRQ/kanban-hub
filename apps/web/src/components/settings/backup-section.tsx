import { getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { DisabledEntry } from "@/components/shell/disabled-entry";
import { SectionRow } from "./section-card";

/** 加密备份：M7 才提供，这一版先按既定布局放上，整个区块置灰、悬停提示“后续版本提供” */
export async function BackupSection() {
  const t = await getTranslations("settings");
  const td = await getTranslations("common");

  return (
    <DisabledEntry tooltip={td("disabledEntry.tooltip")} className="block w-full">
      <SectionRow label={t("backup.create")}>
        <div className="flex flex-wrap items-center gap-3">
          <Input disabled placeholder={t("backup.passwordPlaceholder")} className="max-w-64" />
          <label className="flex items-center gap-1.5 text-sm">
            <Checkbox disabled defaultChecked />
            {t("backup.includeHistory")}
          </label>
          <Button type="button" size="sm" disabled>
            {t("backup.createButton")}
          </Button>
        </div>
      </SectionRow>
    </DisabledEntry>
  );
}
