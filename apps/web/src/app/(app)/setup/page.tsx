import Link from "next/link";
import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getPageSession } from "@/server/web/session";
import { pageServices } from "@/server/web/services";
import { buildSetupView } from "@/server/views/setup";
import { SectionCard, SectionRow } from "@/components/settings/section-card";
import { CopyCommand } from "@/components/setup/copy-command";
import { PairingPanel } from "@/components/setup/pairing-panel";
import { MachineList } from "@/components/setup/machine-list";

/**
 * 接入引导：安装 kh、生成配对码登录本机、注册仓库，加机器列表。
 * `(app)/layout.tsx` 已经校验过会话，这里的 session 一定存在。
 */
export default async function SetupPage() {
  const t = await getTranslations("setup");
  const session = await getPageSession();
  const services = pageServices();
  const h = await headers();

  const view = buildSetupView(services, session!.user.id, {
    forwardedProto: h.get("x-forwarded-proto"),
    forwardedHost: h.get("x-forwarded-host"),
    host: h.get("host"),
  });

  const installCommand = `npm i -g ${view.publicUrl || t("serverPlaceholder")}/setup/kh.tgz`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Link href="/settings" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
          &larr; {t("back")}
        </Link>
        <h1 className="text-xl font-bold">{t("heading")}</h1>
      </div>

      <SectionCard title={t("steps.install.title")} subtitle="install kh">
        <SectionRow label={t("steps.install.requirement")}>
          <CopyCommand command={installCommand} />
        </SectionRow>
      </SectionCard>

      <SectionCard title={t("steps.login.title")} subtitle="kh login">
        <SectionRow label={t("steps.login.label")}>
          <PairingPanel publicUrl={view.publicUrl} />
        </SectionRow>
      </SectionCard>

      <SectionCard title={t("steps.register.title")} subtitle="kh register">
        <SectionRow label={t("steps.register.label")}>
          <CopyCommand command={`cd ${t("steps.register.repoPlaceholder")} && kh register`} />
        </SectionRow>
        <SectionRow label={t("steps.register.noteLabel")}>
          <p className="text-sm text-muted-foreground">{t("steps.register.note")}</p>
        </SectionRow>
      </SectionCard>

      <SectionCard title={t("machines.title")} subtitle="machines">
        <MachineList machines={view.machines} now={services.now()} />
      </SectionCard>
    </div>
  );
}
