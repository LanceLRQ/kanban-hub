import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { authedPageServices } from "@/server/web/services";
import { buildProjectSettingsView } from "@/server/views/project-settings";
import { SectionCard } from "@/components/settings/section-card";
import { LocationCard } from "@/components/project-settings/location-card";
import { ExportButton } from "@/components/project-settings/export-button";

export default async function ProjectSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = await getTranslations("projectSettings");
  const { services } = await authedPageServices();
  const view = buildProjectSettingsView(services, id, services.now());
  if (!view) notFound();

  return (
    <div className="flex flex-col gap-4">
      <SectionCard title={t("locations.title")} subtitle="locations">
        {view.locations.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted-foreground">{t("locations.empty")}</p>
        ) : (
          view.locations.map((location, i) => <LocationCard key={location.machineId} location={location} index={i + 1} />)
        )}
      </SectionCard>

      <SectionCard title={t("actions.title")} subtitle="actions">
        <div className="flex items-center gap-3 px-5 py-3.5">
          <ExportButton />
        </div>
      </SectionCard>
    </div>
  );
}
