import { getTranslations } from "next-intl/server";

/** 占位看板页：真正的看板（容器与任务）由后续开发替换 */
export default async function BoardPlaceholderPage() {
  const t = await getTranslations("common");

  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">{t("placeholderBoard.heading")}</h2>
      <p className="text-muted-foreground">{t("placeholderBoard.body")}</p>
    </div>
  );
}
