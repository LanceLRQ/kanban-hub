import { getTranslations } from "next-intl/server";
import { InboxSection } from "@/components/overview/inbox-section";
import { looseTranslator } from "@/components/overview/loose-translator";
import { ProjectSection } from "@/components/overview/project-section";
import type { EnumLabelFn } from "@/lib/events";
import { pageServices } from "@/server/web/services";
import { buildOverview } from "@/server/views/overview";

/** 总览页：跨项目“待你处理”收件箱 + 项目卡片 */
export default async function OverviewPage() {
  const services = pageServices();
  const now = services.now();

  const te = looseTranslator(await getTranslations("enums"));
  const enumLabel: EnumLabelFn = (group, value) => te(`${group}.${value}`);

  const view = await buildOverview(services, now, enumLabel);

  return (
    <div className="flex flex-col">
      <InboxSection view={view} now={now} />
      <ProjectSection view={view} now={now} />
    </div>
  );
}
