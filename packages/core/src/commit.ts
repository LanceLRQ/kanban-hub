import type { ActorVia, EventType } from "./schema";

const EVENT_LABELS: Record<EventType, string> = {
  "project.created": "新建项目",
  "project.updated": "项目更新",
  "container.created": "新建容器",
  "container.updated": "容器更新",
  "task.created": "新建任务",
  "task.updated": "任务更新",
  "task.status_changed": "任务状态变更",
  "task.human_changed": "待你处理变更",
  log: "日志",
  "docs.synced": "文档同步",
  "docs.pulled": "文档拉取",
  "import.applied": "导入",
};

/** 提交说明里的来源：命令行为 cli(<机器名>)，网页为 web */
export function commitScope(via: ActorVia, machineName: string | null): string {
  return via === "cli" ? `cli(${machineName ?? "未知机器"})` : "web";
}

/** 按事件类型汇总：数量多的在前，数量相同按首次出现的顺序，最多列 3 类 */
export function commitSummary(types: readonly EventType[]): string {
  if (types.length === 0) return "数据更新";
  const counts = new Map<EventType, number>();
  for (const t of types) counts.set(t, (counts.get(t) ?? 0) + 1);
  const parts = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${n} 项${EVENT_LABELS[t]}`);
  return parts.length > 3 ? `${parts.slice(0, 3).join("、")} 等` : parts.join("、");
}

/** 提交说明，例如 cli(mac): 3 项任务状态变更（规格 6.4） */
export function commitMessage(scope: string, types: readonly EventType[]): string {
  return `${scope}: ${commitSummary(types)}`;
}
