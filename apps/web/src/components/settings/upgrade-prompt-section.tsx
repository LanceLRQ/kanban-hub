"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { SectionRow } from "./section-card";

/**
 * 设置页的「升级 kh 与 skill」提示词：一段发给各台开发机上的 AI 助手的完整指令，由它把
 * 那台机器的 kh 命令行、skill 与 hook 升级到服务端当前版本（正文与用户手册《接入》
 * 「升级 kh 与 skill」一节一致）。服务端地址由页面按「配置优先、请求来源推断」解析后
 * 传入，推断不出时退回占位符，发给机器前自行替换。
 * 复制走 navigator.clipboard，不可用（非安全上下文、权限被拒）时退回全选文字让用户手动复制，
 * 与接入页 CopyCommand 的兜底一致。
 */
export function UpgradePromptSection({ serverUrl }: { serverUrl: string }) {
  const t = useTranslations("settings");
  const [copied, setCopied] = useState(false);
  const promptRef = useRef<HTMLPreElement>(null);
  const prompt = t("upgrade.prompt", { serverUrl: serverUrl || t("upgrade.serverPlaceholder") });

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
