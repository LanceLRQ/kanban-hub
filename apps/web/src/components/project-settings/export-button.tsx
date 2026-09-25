import { getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/button";
import { DisabledEntry } from "@/components/shell/disabled-entry";

/** “导出”：M6 才提供，这版先按既定布局放上，置灰不可点 */
export async function ExportButton() {
  const t = await getTranslations("projectSettings");
  const td = await getTranslations("common");

  return (
    <DisabledEntry tooltip={td("disabledEntry.tooltip")}>
      <Button type="button" variant="outline" size="sm" disabled>
        {t("export")}
      </Button>
    </DisabledEntry>
  );
}
