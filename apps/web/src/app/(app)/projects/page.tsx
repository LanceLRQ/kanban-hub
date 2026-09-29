import { getTranslations } from "next-intl/server";
import { looseTranslator } from "@/components/overview/loose-translator";
import { ProjectSection } from "@/components/overview/project-section";
import type { EnumLabelFn } from "@/lib/events";
import { authedPageServices } from "@/server/web/services";
import { buildOverview } from "@/server/views/overview";

/** 项目列表：所有项目的卡片（周期、健康度、焦点、进度、最近活动、位置），点击进入项目页 */
export default async function ProjectsPage() {
  const { services } = await authedPageServices();
  const now = services.now();

  const te = looseTranslator(await getTranslations("enums"));
  const enumLabel: EnumLabelFn = (group, value) => te(`${group}.${value}`);
  const tev = await getTranslations("events");

  const view = await buildOverview(services, now, enumLabel, tev("common.none"));

  return <ProjectSection view={view} now={now} />;
}
