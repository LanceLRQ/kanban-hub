/**
 * 会话开始时注入给 agent 的进度摘要：纯函数，只读 StatusView、自动拉取的结果和本机登记的冲突。
 * 各段有条数上限，超出时写一行“另有 N 项”；全文最后再按行数、字符数截断一次兜底。
 */
import { CYCLE_LABELS, HEALTH_LABELS, HUMAN_KIND_LABELS, TASK_STATUS_LABELS } from "../commands/labels";
import type { PullResult } from "../sync/pull";
import type { StatusView } from "../status/view";
import { HOOK_LIMITS } from "./exit";

export type SessionPull =
  /** pull.auto 为 false：没有拉取 */
  | { kind: "off" }
  /** 其他机器都还没有同步过 */
  | { kind: "none" }
  | { kind: "done"; result: PullResult }
  /** 另一个同步或拉取正在进行，没有拉取 */
  | { kind: "busy" }
  | { kind: "failed"; message: string; partial: PullResult | null };

export interface SessionSummaryInput {
  view: StatusView;
  pull: SessionPull;
  conflicts: { path: string; machineName: string }[];
}

const MAX_TASKS = 12;
const MAX_INBOX = 8;
const MAX_CONFLICTS = 8;
/** 单行最多这么多个字符，超长的标题、备注截断，避免几行长文本挤掉后面的段落 */
const MAX_LINE_CHARS = 100;

export const RULE_LINES = [
  "上报规则：开始任务标 in_progress，做完标 review，验证通过才标 done；新发现的问题用 kh task add misc <标题> 记下，完成一批工作后用 kh log 写日志。",
  "#短ID 在 shell 里要加引号（例如 \"#a1b2\"）；完整规则见 kanban-hub skill。",
];

function clip(line: string): string {
  const chars = Array.from(line);
  return chars.length <= MAX_LINE_CHARS ? line : `${chars.slice(0, MAX_LINE_CHARS - 1).join("")}…`;
}

/** 路径里有空白或 shell 特殊字符时加单引号，这样整行命令可以直接复制执行 */
function shellArg(value: string): string {
  if (/^[A-Za-z0-9_./@%+=:,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function limited(lines: string[], max: number, overflowHint: string): string[] {
  if (lines.length <= max) return lines;
  return [...lines.slice(0, max), `  另有 ${lines.length - max} 项，执行 ${overflowHint} 查看`];
}

function taskLines(view: StatusView): string[] {
  const lines: string[] = [];
  for (const container of view.containers) {
    for (const task of container.tasks) {
      if (task.status !== "in_progress" && task.status !== "review") continue;
      const code = task.code !== null ? `${container.refLabel}/${task.code}` : null;
      const parts = [TASK_STATUS_LABELS[task.status], task.ref, code, task.title].filter((p): p is string => p !== null);
      lines.push(`  ${parts.join(" ")}`);
    }
  }
  return lines;
}

function pullCounts(result: PullResult): string | null {
  const items: [string, number][] = [
    ["新建", result.created.length],
    ["覆盖", result.overwritten.length],
    ["自动合并", result.merged.length],
    ["冲突", result.conflicts.length],
  ];
  const nonZero = items.filter(([, n]) => n > 0);
  return nonZero.length === 0 ? null : `自动拉取：${nonZero.map(([label, n]) => `${label} ${n}`).join("、")}`;
}

function pullLines(pull: SessionPull): string[] {
  switch (pull.kind) {
    case "off":
    case "none":
      return [];
    case "busy":
      return ["另一个同步或拉取正在进行，本次没有自动拉取"];
    case "done": {
      const lines: string[] = [];
      const counts = pullCounts(pull.result);
      if (counts !== null) lines.push(counts);
      if (pull.result.timedOut) lines.push("自动拉取超时，已停止；稍后执行 kh pull");
      return lines;
    }
    case "failed": {
      const lines: string[] = [];
      const counts = pull.partial !== null ? pullCounts(pull.partial) : null;
      if (counts !== null) lines.push(counts);
      const reason = pull.message.split("\n", 1)[0] ?? "";
      lines.push(`自动拉取失败：${reason}；稍后执行 kh pull`);
      return lines;
    }
  }
}

export function renderSessionSummary(input: SessionSummaryInput): string {
  const { view, pull, conflicts } = input;
  const { project } = view;
  const lines: string[] = [
    `kanban-hub 项目：${project.name} · ${CYCLE_LABELS[project.cycle]} · ${HEALTH_LABELS[project.health]} · 进度 ${project.progress.done}/${project.progress.total}`,
    `焦点：${project.focus.trim() === "" ? "（未设置）" : project.focus}`,
  ];

  const tasks = taskLines(view);
  if (tasks.length === 0) lines.push("进行中：没有进行中或复核中的任务");
  else lines.push(`进行中（${tasks.length}）：`, ...limited(tasks, MAX_TASKS, "kh status"));

  if (view.inbox.length > 0) {
    const inbox = view.inbox.map((item) => {
      const kind = HUMAN_KIND_LABELS[item.kind];
      return `  ${item.ref} ${item.taskTitle}（${item.note === "" ? kind : `${kind}：${item.note}`}）`;
    });
    lines.push(`待你处理（${inbox.length}）：`, ...limited(inbox, MAX_INBOX, "kh status"));
  }

  lines.push(...pullLines(pull));

  if (conflicts.length > 0) {
    const items = conflicts.map((c) => `  ${c.path}（对方：${c.machineName}）→ kh conflicts show ${shellArg(c.path)}`);
    lines.push(`未解决的冲突（${conflicts.length}），先处理冲突再开始任务：`, ...limited(items, MAX_CONFLICTS, "kh conflicts"));
  }

  lines.push(...RULE_LINES);
  return truncate(lines.map(clip));
}

/** 兜底：按行数、字符数截断；正常情况下各段的上限已经保证不会走到这里 */
function truncate(lines: string[]): string {
  const kept = lines.slice(0, HOOK_LIMITS.summaryMaxLines);
  let text = `${kept.join("\n")}\n`;
  while (text.length > HOOK_LIMITS.summaryMaxChars && kept.length > 0) {
    kept.pop();
    text = `${kept.join("\n")}\n`;
  }
  return text;
}
