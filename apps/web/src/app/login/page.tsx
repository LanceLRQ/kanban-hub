import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getPageSession } from "@/server/web/session";
import { sanitizeNextPath } from "@/lib/client/next-path";
import { LoginForm } from "@/components/auth/login-form";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const nextPath = sanitizeNextPath(next);

  const session = await getPageSession();
  if (session) redirect(nextPath);

  const t = await getTranslations("common");
  const tl = await getTranslations("login");

  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-12">
      <div className="flex w-[400px] flex-col gap-4 rounded-lg border bg-card px-9 py-9 shadow-sm">
        <div className="font-mono text-2xl font-semibold tracking-tight">{t("wordmark")}</div>
        <p className="-mt-2 text-sm font-medium text-muted-foreground">{tl("subtitle")}</p>
        <LoginForm nextPath={nextPath} />
        <p className="border-t pt-3 text-xs font-medium text-muted-foreground">{tl("hint")}</p>
      </div>
    </main>
  );
}
