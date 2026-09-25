import Link from "next/link";
import { getTranslations } from "next-intl/server";

/** (app) 分组下 notFound() 的落地页；目前唯一的调用方是项目页框架（项目不存在） */
export default async function AppNotFound() {
  const t = await getTranslations("common");

  return (
    <div className="mx-auto flex max-w-[1240px] flex-col items-center gap-4 px-8 py-24 text-center">
      <h1 className="text-xl font-semibold">{t("notFound.project.heading")}</h1>
      <p className="text-muted-foreground">{t("notFound.project.body")}</p>
      <Link href="/" className="text-sm font-medium underline underline-offset-4">
        {t("notFound.project.back")}
      </Link>
    </div>
  );
}
