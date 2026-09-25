import { getTranslations } from "next-intl/server";

/** 占位首页：真正的总览页（收件箱 + 项目卡片）由后续开发替换 */
export default async function OverviewPlaceholderPage() {
  const t = await getTranslations("common");

  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-xl font-semibold">{t("placeholderHome.heading")}</h1>
      <p className="text-muted-foreground">{t("placeholderHome.body")}</p>
    </div>
  );
}
