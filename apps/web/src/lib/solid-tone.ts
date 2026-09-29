import type { ContainerStatus } from "@kanban-hub/core/derive";
import type { Health, HumanKind, TaskStatus } from "@kanban-hub/core/schema";

/*
 * 实心标签（背景色 + 白字）的类名：`kh-solid` 加上指定语义色的 `--solid-tone`，外观规则见
 * globals.css 的 `.kh-solid`。类名要写成完整的字面量，Tailwind 才扫描得到。
 */

export const HEALTH_TONE: Record<Health, string> = {
  on_track: "kh-solid [--solid-tone:var(--health-on-track)]",
  at_risk: "kh-solid [--solid-tone:var(--health-at-risk)]",
  blocked: "kh-solid [--solid-tone:var(--health-blocked)]",
};

export const HUMAN_TONE: Record<HumanKind, string> = {
  decision: "kh-solid [--solid-tone:var(--human-decision)]",
  verify: "kh-solid [--solid-tone:var(--human-verify)]",
  action: "kh-solid [--solid-tone:var(--human-action)]",
};

const STATUS_TONE: Partial<Record<ContainerStatus | TaskStatus, string>> = {
  in_progress: "kh-solid [--solid-tone:var(--task-in-progress)]",
  review: "kh-solid [--solid-tone:var(--task-review)]",
  done: "kh-solid [--solid-tone:var(--task-done)]",
  suspended: "kh-solid [--solid-tone:var(--task-suspended)]",
};

/** 状态标签的实心类名；待开始、待排期、已取消不做实心（仍是描边），返回 null */
export function statusTone(status: ContainerStatus | TaskStatus): string | null {
  return STATUS_TONE[status] ?? null;
}
