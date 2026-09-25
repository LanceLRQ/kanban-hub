import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";
import { authedPageServices } from "@/server/web/services";
import { buildSetupView } from "@/server/views/setup";
import { PageTitleCard, SectionCard, SectionRow } from "@/components/settings/section-card";
import { CopyCommand } from "@/components/setup/copy-command";
import { PairingPanel } from "@/components/setup/pairing-panel";
import { MachineList } from "@/components/setup/machine-list";

/** 接入引导：安装 kh、生成配对码登录本机、注册仓库，加机器列表。 */
export default async function SetupPage() {
  const t = await getTranslations("setup");
  const { services, user } = await authedPageServices();
  const h = await headers();

  const view = buildSetupView(services, user.id, {
    forwardedProto: h.get("x-forwarded-proto"),
    forwardedHost: h.get("x-forwarded-host"),
    host: h.get("host"),
  });

  const installCommand = `npm i -g ${view.publicUrl || t("serverPlaceholder")}/setup/kh.tgz`;

  return (
    <div className="flex flex-col gap-4">
      <PageTitleCard title={t("heading")} subtitle="setup" backHref="/settings" backLabel={t("back")} />

      <SectionCard no="1" title={t("steps.install.title")} subtitle="install kh">
        <SectionRow label={t("steps.install.requirement")}>
          <CopyCommand command={installCommand} />
        </SectionRow>
      </SectionCard>

      <SectionCard no="2" title={t("steps.login.title")} subtitle="kh login">
        <SectionRow label={t("steps.login.label")}>
          <PairingPanel publicUrl={view.publicUrl} />
        </SectionRow>
      </SectionCard>

      <SectionCard no="3" title={t("steps.register.title")} subtitle="kh register">
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
