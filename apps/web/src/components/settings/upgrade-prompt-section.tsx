"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { SectionRow } from "./section-card";

/**
 * 设置页的升级提示词：一段发给「部署了看板服务端的那台机器」上的 AI 助手的完整指令，
 * 由它查明部署方式（一键脚本 / 手动 compose / 源码构建）并升级到最新正式版。提示词本身
 * 不写死版本号——升级目标由 AI 从 GitHub releases 查最新版得到，这段文案不随发版过期。
 * 复制走 navigator.clipboard，不可用（非安全上下文、权限被拒）时退回全选文字让用户手动复制，
 * 与接入页 CopyCommand 的兜底一致。
 */
export function UpgradePromptSection() {
  const t = useTranslations("settings");
  const [copied, setCopied] = useState(false);
  const promptRef = useRef<HTMLPreElement>(null);
  const prompt = t("upgrade.prompt");

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      const range = document.createRange();
      if (promptRef.current) {
        range.selectNodeContents(promptRef.current);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      toast.error(t("upgrade.copyFailed"));
    }
  }

  return (
    <>
      <SectionRow label={t("upgrade.hint")}>{t("upgrade.description")}</SectionRow>
      <SectionRow label={t("upgrade.promptLabel")}>
        <div className="flex flex-col gap-2.5">
          <div className="flex justify-end">
            <Button type="button" variant="outline" size="sm" onClick={() => void handleCopy()}>
              {copied ? t("upgrade.copied") : t("upgrade.copy")}
            </Button>
          </div>
          <pre
            ref={promptRef}
            className="max-h-80 overflow-y-auto whitespace-pre-wrap rounded-sm border bg-muted/60 px-4 py-3 text-xs leading-relaxed"
          >
            {prompt}
          </pre>
        </div>
      </SectionRow>
    </>
  );
}
