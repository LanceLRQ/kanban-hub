"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

/**
 * (app) 分组下的错误边界。生产环境下 Server Component 抛出的错误会被脱敏成通用消息，
 * 这里不去分辨具体错误类型，统一显示通用提示并给一个重试按钮；下方补一句针对“服务还在
 * 启动”这类情况的提示，不当作唯一可能的原因。
 */
export default function AppError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const t = useTranslations("common");

  return (
    <div className="mx-auto flex max-w-[1240px] flex-col items-center gap-4 px-8 py-24 text-center">
      <h1 className="text-xl font-semibold">{t("error.generic.heading")}</h1>
      <p className="text-muted-foreground">{t("error.generic.body")}</p>
      <p className="text-sm text-muted-foreground">{t("error.unavailable.body")}</p>
      <Button onClick={() => retry()}>{t("error.generic.retry")}</Button>
    </div>
  );
}
