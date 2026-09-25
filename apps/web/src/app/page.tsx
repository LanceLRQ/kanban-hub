import { getTranslations } from "next-intl/server";
import { KH_VERSION } from "@kanban-hub/core/version";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/**
 * 外观地基的样式验证页：证明 Tailwind、主题 token、字体、next-intl 都接通了。
 * 这只是临时占位——本项目会把它挪到 app/(app)/ 下并换成真正的总览页。
 */
export default async function HomePage() {
  const t = await getTranslations("common");

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 px-6 py-16">
      <div>
        <h1 className="text-2xl">{t("wordmark")}</h1>
        <p className="text-muted-foreground">{t("tagline")}</p>
      </div>

      <section className="flex flex-col gap-3 rounded-md border bg-card p-6">
        <h2 className="text-lg">{t("styleCheck.heading")}</h2>
        <p>{t("styleCheck.body")}</p>
        <p className="kh-num text-sm text-muted-foreground">{t("styleCheck.sample")}</p>
        <div className="flex items-center gap-3">
          <Button>{t("styleCheck.action")}</Button>
          <Badge variant="secondary">v{KH_VERSION}</Badge>
        </div>
      </section>
    </main>
  );
}
