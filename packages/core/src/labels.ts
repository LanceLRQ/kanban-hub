/**
 * 枚举取值的中文名（规格 5.3；容器手动状态见规格 5.2“容器”表格）。
 * 命令行、网页与导入导出统一从这里取中文名，避免各处各写一份、逐渐不一致。
 */
import type { ContainerStatus } from "./derive";
import type { ContainerKind, Cycle, Health, HumanKind, ManualStatus, TaskStatus } from "./schema";

export const CYCLE_LABELS: Record<Cycle, string> = {
  design: "设计期",
  development: "开发期",
  iteration: "迭代期",
  maintenance: "维护期",
  archived: "归档",
};

export const HEALTH_LABELS: Record<Health, string> = {
  on_track: "正常",
  at_risk: "有风险",
  blocked: "卡住",
};

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "待开始",
  in_progress: "进行中",
  review: "复核中",
  done: "已完成",
  suspended: "挂起",
  cancelled: "已取消",
};

export const HUMAN_KIND_LABELS: Record<HumanKind, string> = {
  decision: "待决策",
  verify: "待验证",
  action: "待操作",
};

export const MANUAL_STATUS_LABELS: Record<ManualStatus, string> = {
  backlog: "储备",
  suspended: "挂起",
  cancelled: "已取消",
};

export const CONTAINER_KIND_LABELS: Record<ContainerKind, string> = {
  phase: "阶段",
  feature: "特性",
  misc: "杂项",
};

/** 容器的显示状态（推算出的或手动设置的，见 derive.ts 的 containerStatus） */
export const CONTAINER_STATUS_LABELS: Record<ContainerStatus, string> = {
  todo: "待开始",
  in_progress: "进行中",
  done: "已完成",
  backlog: "储备",
  suspended: "挂起",
  cancelled: "已取消",
};
