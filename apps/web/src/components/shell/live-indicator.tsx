"use client";

import { useTranslations } from "next-intl";
import { useLiveStatus } from "@/components/live/use-live-status";

/** 连接正常时不渲染任何内容；断开或重连中时显示小标记 */
export function LiveIndicator() {
  const status = useLiveStatus();
  const t = useTranslations("common");
  if (status === "connected") return null;

  return (
    <span className="kh-num rounded-md border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
      {t("liveStatus.disconnected")}
    </span>
  );
}
