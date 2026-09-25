import Link from "next/link";
import { getTranslations } from "next-intl/server";

/**
 * 根级 404：接住任何匹配不到路由的地址（例如 `/随便什么`）。这是唯一一层能兜住
 * “完全没有对应路由”的情况——`(app)/not-found.tsx` 只处理 `(app)` 这个分组内部
 * 调用 `notFound()` 的场景（比如项目不存在），两者不重复。这里渲染在根布局之外的
 * 任何嵌套布局之内，所以拿不到会话，也不假设用户已登录。
 */
export default async function RootNotFound() {
  const t = await getTranslations("common");

  return (
    <main className="mx-auto flex min-h-screen max-w-[1240px] flex-col items-center justify-center gap-4 px-8 text-center">
      <h1 className="text-xl font-semibold">{t("notFound.page.heading")}</h1>
      <p className="text-muted-foreground">{t("notFound.page.body")}</p>
      <Link href="/" className="text-sm font-medium underline underline-offset-4">
        {t("notFound.page.back")}
      </Link>
    </main>
  );
}
