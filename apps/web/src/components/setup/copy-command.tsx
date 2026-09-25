"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/**
 * 一行命令 + 复制按钮。`navigator.clipboard` 不可用或复制失败时，退回选中命令文字，
 * 并提示用户手动复制（Clipboard API 在非安全上下文，或权限被拒绝时都可能失败）。
 */
export function CopyCommand({ command }: { command: string }) {
  const t = useTranslations("setup");
  const [copied, setCopied] = useState(false);
  const codeRef = useRef<HTMLElement>(null);

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      const range = document.createRange();
      if (codeRef.current) {
        range.selectNodeContents(codeRef.current);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      toast.error(t("copyFailed"));
    }
  }

  return (
    <div className="flex items-center gap-2">
      <code ref={codeRef} className="kh-num min-w-0 flex-1 overflow-x-auto whitespace-pre rounded-sm bg-muted px-2.5 py-1.5 text-xs">
        {command}
      </code>
      <Button type="button" variant="outline" size="sm" onClick={() => void handleCopy()}>
        {copied ? t("copied") : t("copy")}
      </Button>
    </div>
  );
}
