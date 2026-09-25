import { getTranslations } from "next-intl/server";
import { pageServices } from "@/server/web/services";
import { buildSettingsView } from "@/server/views/settings";
import { SectionCard, SectionRow } from "@/components/settings/section-card";
import { AppearanceSection } from "@/components/settings/appearance-section";
import { BackupSection } from "@/components/settings/backup-section";
import { ConnectSection } from "@/components/settings/connect-section";

export default async function SettingsPage() {
  const t = await getTranslations("settings");
  const services = pageServices();
  const view = buildSettingsView(services);

  const pendingCommitsText =
    view.pendingCommits === 0 ? t("service.pendingCommitsNone") : t("service.pendingCommitsSome", { count: view.pendingCommits });
  const publicUrlText = view.publicUrl ?? t("service.publicUrlUnset");

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-bold">{t("heading")}</h1>

      <SectionCard title={t("appearance.title")} subtitle="appearance">
        <AppearanceSection />
      </SectionCard>

      <SectionCard title={t("service.title")} subtitle="service">
        <SectionRow label={t("service.version")}>
          <span className="kh-num">{view.version}</span>
        </SectionRow>
        <SectionRow label={t("service.dataDirectory")}>
          <span className="kh-num break-all">{view.dataDirectory}</span>
        </SectionRow>
        <SectionRow label={t("service.pendingCommits")}>{pendingCommitsText}</SectionRow>
        <SectionRow label={t("service.publicUrl")}>
          <span className="kh-num break-all">{publicUrlText}</span>
        </SectionRow>
        <SectionRow label={t("service.staleDays")}>
          <span className="kh-num">{t("service.staleDaysValue", { days: view.staleDays })}</span>
        </SectionRow>
      </SectionCard>

      <SectionCard title={t("backup.title")} subtitle="backup">
        <BackupSection />
      </SectionCard>

      <SectionCard title={t("connect.title")} subtitle="connect">
        <ConnectSection />
      </SectionCard>
    </div>
  );
}
