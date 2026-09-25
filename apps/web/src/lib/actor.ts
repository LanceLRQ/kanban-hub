/**
 * 操作者的显示（细节「操作者」）：网页操作显示用户名；命令行操作显示 agent 名，
 * 后面带机器名；没有 agent 时只显示机器名。
 */
import type { Actor } from "@kanban-hub/core/schema";

export interface ActorLabelContext {
  userName(id: string): string;
  machineName(id: string): string;
}

export interface ActorLabel {
  primary: string;
  /** 网页操作、或命令行操作没有 agent 时为 null；组件决定怎么给它加括号 */
  secondary: string | null;
}

export function actorLabel(actor: Actor, ctx: ActorLabelContext): ActorLabel {
  if (actor.via === "web") return { primary: ctx.userName(actor.userId), secondary: null };
  // actorSchema 保证 via === "cli" 时 machineId 不为 null
  const machine = ctx.machineName(actor.machineId!);
  if (actor.agent !== null) return { primary: actor.agent, secondary: machine };
  return { primary: machine, secondary: null };
}
