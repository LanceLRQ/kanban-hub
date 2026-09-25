"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

/**
 * (app) 分组下的错误边界。最常见的触发场景是服务容器还没启动完（`getServices()` 抛出
 * `KhError("unavailable")`）；生产环境下 Server Component 抛出的错误会被脱敏成通用消息，
 * 这里不去分辨具体错误类型，统一提示“服务还在启动，请稍后刷新”并给一个重试按钮。
 */
export default function AppError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const t = useTranslations("common");

  return (
    <div className="mx-auto flex max-w-[1240px] flex-col items-center gap-4 px-8 py-24 text-center">
      <h1 className="text-xl font-semibold">{t("error.unavailable.heading")}</h1>
      <p className="text-muted-foreground">{t("error.unavailable.body")}</p>
      <Button onClick={() => retry()}>{t("error.generic.retry")}</Button>
    </div>
  );
}
