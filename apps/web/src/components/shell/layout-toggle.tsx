"use client";

import { FoldHorizontalIcon, UnfoldHorizontalIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePreferences } from "@/lib/preferences";

/** 顶栏的宽屏/窄屏切换按钮：当前宽屏时显示“切到窄屏”的图标，反之亦然 */
export function LayoutToggle() {
  const t = useTranslations("common");
  const { preferences, setLayout } = usePreferences();
  const isWide = preferences.layout === "wide";
  const label = isWide ? t("topBar.layoutToNarrow") : t("topBar.layoutToWide");

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => setLayout(isWide ? "narrow" : "wide")}
      className={cn(buttonVariants({ variant: "outline", size: "icon-sm" }))}
    >
      {isWide ? <FoldHorizontalIcon /> : <UnfoldHorizontalIcon />}
    </button>
  );
}
