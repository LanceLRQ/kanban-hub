"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { useMutation } from "@/lib/client/api";
import { CopyCommand } from "./copy-command";
import { formatCountdown, remainingSeconds } from "./countdown";

const pairingResponseSchema = z.object({ code: z.string(), expiresAt: z.string() });

/**
 * 步骤 2“登录本机”：生成配对码、显示倒计时、拼好 `kh login` 命令。
 * 没生成配对码时命令里的配对码用占位 `<配对码>`；过期后提示重新生成，不再显示旧码。
 */
export function PairingPanel({ publicUrl }: { publicUrl: string }) {
  const t = useTranslations("setup");
  const { mutate } = useMutation();
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string } | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!pairing) return;
    const tick = () => setRemaining(remainingSeconds(pairing.expiresAt, new Date()));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [pairing]);

  async function handleGenerate(): Promise<void> {
    setPending(true);
    try {
      const result = await mutate<unknown>("/api/v1/pairing-codes", "POST");
      if (result === null) return;
      const parsed = pairingResponseSchema.safeParse(result);
      if (!parsed.success) {
        toast.error(t("generateFailed"));
        return;
      }
      setPairing(parsed.data);
      setRemaining(remainingSeconds(parsed.data.expiresAt, new Date()));
    } finally {
      setPending(false);
    }
  }

  const expired = pairing !== null && remaining <= 0;
  const code = pairing && !expired ? pairing.code : null;
  const loginCommand = `kh login --server ${publicUrl || t("serverPlaceholder")} --code ${code ?? t("codePlaceholder")}`;

  return (
    <div className="flex flex-col gap-3 px-5 py-3.5">
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" size="sm" onClick={() => void handleGenerate()} disabled={pending}>
          {t("generateCode")}
        </Button>
        {code && (
          <span className="kh-num flex items-center gap-2 text-sm">
            <span className="rounded-sm border bg-secondary/40 px-2 py-1 font-bold tracking-widest">{code}</span>
            <span className="text-xs text-muted-foreground">{t("codeExpiresIn", { time: formatCountdown(remaining) })}</span>
          </span>
        )}
        {expired && <span className="text-xs text-destructive">{t("codeExpired")}</span>}
      </div>
      <CopyCommand command={loginCommand} />
    </div>
  );
}
