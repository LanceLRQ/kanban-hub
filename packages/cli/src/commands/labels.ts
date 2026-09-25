/**
 * 枚举取值的中文名（规格 5.3；容器手动状态见规格 5.2“容器”表格）。
 * 命令行的选项值一律用 core 的英文取值，这里只用来渲染中文名和拼校验提示。
 */
import type { Cycle, Health, HumanKind, ManualStatus, TaskStatus } from "@kanban-hub/core/schema";

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
