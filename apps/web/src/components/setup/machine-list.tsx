import { getTranslations } from "next-intl/server";
import type { MachineView } from "@/server/api/machine-view";
import { formatDate, formatRelative, serverTimeZone } from "@/lib/time";
import { RevokeButton } from "./revoke-button";

/**
 * 接入页下方的机器列表：名称、系统、最后在线（相对时间，从未在线写“从未”）、接入时间、状态。
 * 服务端组件——日期在这里按服务端时区格式化好，只有吊销按钮是客户端子组件。
 */
export async function MachineList({ machines, now }: { machines: MachineView[]; now: Date }) {
  const t = await getTranslations("setup");
  const tz = serverTimeZone();

  if (machines.length === 0) {
    return <p className="px-5 py-4 text-sm text-muted-foreground">{t("machines.empty")}</p>;
  }

  return (
    <div className="divide-y">
      {machines.map((machine) => (
        <div key={machine.id} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-5 py-3">
          <span className="min-w-[8rem] flex-1 text-sm font-bold">{machine.name}</span>
          <span className="kh-num text-xs text-muted-foreground">{t(`machines.os.${machine.os}`)}</span>
          <span className="kh-num text-xs text-muted-foreground">
            {t("machines.lastSeen", { value: machine.lastSeenAt === null ? t("machines.never") : formatRelative(machine.lastSeenAt, now) })}
          </span>
          <span className="kh-num text-xs text-muted-foreground">{t("machines.joinedAt", { value: formatDate(machine.createdAt, tz, now) })}</span>
          <span className="ml-auto flex items-center gap-3">
            {machine.revokedAt === null ? (
              <RevokeButton machineId={machine.id} machineName={machine.name} />
            ) : (
              <span className="kh-num text-xs text-muted-foreground">{t("machines.revokedAt", { value: formatDate(machine.revokedAt, tz, now) })}</span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
