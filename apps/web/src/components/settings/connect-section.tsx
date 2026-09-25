import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SectionRow } from "./section-card";

/** 接入：一行说明 + 去接入页的按钮 */
export async function ConnectSection() {
  const t = await getTranslations("settings");

  return (
    <SectionRow label={t("connect.label")}>
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-muted-foreground">{t("connect.description")}</p>
        <Link href="/setup" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
          {t("connect.action")}
        </Link>
      </div>
    </SectionRow>
  );
}
