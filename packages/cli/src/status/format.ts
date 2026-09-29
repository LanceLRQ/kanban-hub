import { shortIdPrefixes } from "@kanban-hub/core/ids";
import type { Container } from "@kanban-hub/core/schema";

/** 命令输出里统一的空值占位：null 或空字符串都显示成全角“（无）”，非空原样显示 */
export function displayEmpty(value: string | null | undefined): string {
  return value === null || value === undefined || value === "" ? "（无）" : value;
}

/**
 * 容器在命令输出里的显示标签：有编号用编号；杂项容器固定显示 misc；否则用整个看板范围内
 * 能互相区分的最短 ID 前缀（至少 4 位）——resolveContainerRef 认 ID 前缀，这样写出来的
 * "<前缀>/2.4" 能直接拿来引用容器或任务，不会像旧版的 "(无编号)" 占位那样没法用。
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
