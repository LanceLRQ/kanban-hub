import { getTranslations } from "next-intl/server";
import type { OverviewView } from "@/server/views/overview";
import { formatRelative } from "@/lib/time";
import { InboxGroupCard } from "./inbox-group-card";
import { SectionHead } from "./section-head";

/** 总览页“待你处理”收件箱：三个固定分组，跨项目汇总；没有任何条目时显示空状态提示 */
export async function InboxSection({ view, now }: { view: OverviewView; now: Date }) {
  const t = await getTranslations("overview");
  const te = await getTranslations("enums");
  const total = view.inbox.reduce((sum, group) => sum + group.items.length, 0);

  return (
    <section>
      <SectionHead no="01" title={t("inbox.heading")} count={total} tag="inbox" tone="attention" />
      {total === 0 ? (
        <p className="kh-radius-c rounded-md border border-dashed bg-card px-6 py-8 text-center text-sm font-medium text-muted-foreground">
          {t("inbox.empty")}
        </p>
      ) : (
        <div className="grid gap-5 md:grid-cols-3">
          {view.inbox.map((group) => (
            <InboxGroupCard
              key={group.kind}
              kind={group.kind}
              title={t("inbox.groupTitle", { label: te(`humanKind.${group.kind}`), count: group.items.length })}
              items={group.items.map((item) => ({
                projectId: item.projectId,
                taskId: item.taskId,
                ref: item.ref,
                text: item.text,
                projectName: item.projectName,
                relativeTime: formatRelative(item.updatedAt, now),
              }))}
              collapseLabel={t("inbox.collapse")}
              expandLabel={t("inbox.expand")}
            />
          ))}
        </div>
      )}
    </section>
  );
}
