import { getTranslations } from "next-intl/server";
import type { User } from "@kanban-hub/core/schema";
import { formatToday, serverTimeZone } from "@/lib/time";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { NavLinks } from "./nav-links";
import { LogoutButton } from "./logout-button";
import { LiveIndicator } from "./live-indicator";

/** 顶栏：wordmark、导航（总览/时间线/设置）、当天日期、用户区、退出。日期按服务端时区显示 */
export async function TopBar({ user, now }: { user: User; now: Date }) {
  const t = await getTranslations("common");
  const tz = serverTimeZone();

  const navItems = [
    { href: "/", label: t("nav.overview") },
    { href: "/timeline", label: t("nav.timeline") },
    { href: "/settings", label: t("nav.settings") },
  ];

  return (
    <header className="border-b bg-card">
      <div className="mx-auto flex max-w-[1240px] flex-wrap items-center gap-x-6 gap-y-2 px-8 py-3.5">
        <div className="kh-wordmark text-2xl font-semibold tracking-tight">{t("wordmark")}</div>
        <span className="hidden self-end pb-0.5 text-[11px] font-bold tracking-[0.14em] text-muted-foreground sm:inline">
          {t("tagline")}
        </span>
        <NavLinks items={navItems} ariaLabel={t("nav.ariaLabel")} />
        <div className="ml-auto flex items-center gap-3">
          <LiveIndicator />
          <span className="kh-topbar-date kh-num text-xs font-medium text-muted-foreground">{formatToday(now, tz)}</span>
          <span className={cn(buttonVariants({ variant: "outline", size: "sm" }), "cursor-default shadow-none")}>
            {user.name} · {t(`role.${user.role}`)}
          </span>
          <LogoutButton label={t("topBar.logout")} />
        </div>
      </div>
    </header>
  );
}
