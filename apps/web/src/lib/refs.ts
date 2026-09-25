/**
 * 容器 / 任务在网页上的引用标签，与 kh 输出同一口径（packages/cli/src/commands/shared.ts 的
 * containerRefLabel）。以后如果下沉 core，两边再一起改。
 */
import { shortIdPrefixes } from "@kanban-hub/core/ids";
import type { Board, Container } from "@kanban-hub/core/schema";

/** 任务的短引用：# 加整个看板范围内能互相区分的最短 ID 前缀（至少 4 位） */
export function taskShortRef(board: Pick<Board, "tasks">, taskId: string): string {
  const prefixes = shortIdPrefixes(board.tasks.map((t) => t.id));
  return `#${prefixes.get(taskId) ?? taskId}`;
}

/**
 * 容器的显示标签：有编号用编号；杂项容器固定显示 misc；否则用整个看板范围内能互相区分的
 * 最短 ID 前缀（至少 4 位）。
 */
export function containerRefLabel(
  container: Pick<Container, "id" | "kind" | "code">,
  allContainers: readonly Pick<Container, "id">[],
): string {
  if (container.code !== null) return container.code;
  if (container.kind === "misc") return "misc";
  const prefixes = shortIdPrefixes(allContainers.map((c) => c.id));
  return prefixes.get(container.id) ?? container.id;
}
