/**
 * 枚举取值的中文名：转出 core 的定义，避免命令行、网页、导入导出各写一份。
 * 命令行的选项值一律用 core 的英文取值，这里只用来渲染中文名和拼校验提示。
 */
export {
  CYCLE_LABELS,
  HEALTH_LABELS,
  TASK_STATUS_LABELS,
  HUMAN_KIND_LABELS,
  MANUAL_STATUS_LABELS,
} from "@kanban-hub/core/labels";
