import { CliError, EXIT } from "../errors";

/** 本工具往 Claude Code settings.json 里合并的两个 hook 命令 */
export const HOOK_COMMANDS = {
  SessionStart: "kh hook session-start",
  Stop: "kh hook stop",
} as const;

/** 写进 settings.json 的 hook 超时（秒） */
export const HOOK_TIMEOUT_SECONDS = 15;

type HookEventName = keyof typeof HOOK_COMMANDS;
const HOOK_EVENT_NAMES = Object.keys(HOOK_COMMANDS) as HookEventName[];

export interface MergeHooksResult {
  next: Record<string, unknown>;
  /** 本次安装新增了 hook 的事件名（已安装过的事件不会重复出现） */
  added: string[];
  /** 本次卸载移除了 hook 的事件名 */
  removed: string[];
}

/** settings.json 结构不符合预期时抛出，路径例如 "hooks.Stop[1].hooks" */
function invalidStructure(path: string): never {
  const where = path === "" ? "顶层" : path;
  throw new CliError(EXIT.DATA, `settings.json 的结构不符合预期：${where}`, "手动检查该处内容，或删除后重新执行 kh setup");
}

function asPlainObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalidStructure(path);
  return value as Record<string, unknown>;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) invalidStructure(path);
  return value;
}

interface HookEntry {
  command?: unknown;
  [key: string]: unknown;
}

interface HookGroup {
  hooks: HookEntry[];
  [key: string]: unknown;
}

/** 校验并原样返回一个 hook 组：{ matcher?, hooks: [{ type, command, timeout, ... }] } */
function validateGroup(raw: unknown, path: string): HookGroup {
  const group = asPlainObject(raw, path);
  const entries = asArray(group.hooks, `${path}.hooks`).map((entry, i) => validateEntry(entry, `${path}.hooks[${i}]`));
  return { ...group, hooks: entries };
}

function validateEntry(raw: unknown, path: string): HookEntry {
  const entry = asPlainObject(raw, path);
  if (entry.command !== undefined && typeof entry.command !== "string") invalidStructure(`${path}.command`);
  return entry;
}

function isOurCommand(entry: HookEntry, command: string): boolean {
  return typeof entry.command === "string" && entry.command.trim() === command;
}

/**
 * 合并（或移除）两个 hook 条目。只校验、只改动 SessionStart、Stop 这两个事件本身的结构；
 * `hooks` 下的其他事件、`settings.json` 里的其他顶层字段原样保留，不做任何结构假设。
 * 结构不合法时抛 CliError(5)，不返回任何结果——调用方据此判断“整个 setup 什么都不写”。
 */
export function mergeClaudeHooks(settings: unknown, mode: "install" | "uninstall"): MergeHooksResult {
  const root = asPlainObject(settings, "");
  const next: Record<string, unknown> = { ...root };

  const hooksRaw = root.hooks;
  const hooks: Record<string, unknown> = hooksRaw === undefined ? {} : { ...asPlainObject(hooksRaw, "hooks") };

  const added: string[] = [];
  const removed: string[] = [];

  for (const event of HOOK_EVENT_NAMES) {
    const command = HOOK_COMMANDS[event];
    const eventRaw = hooks[event];
    const groups = eventRaw === undefined ? [] : asArray(eventRaw, `hooks.${event}`).map((g, i) => validateGroup(g, `hooks.${event}[${i}]`));

    if (mode === "install") {
      const alreadyInstalled = groups.some((g) => g.hooks.some((entry) => isOurCommand(entry, command)));
      if (alreadyInstalled) continue;
      const newGroup: HookGroup = { hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_SECONDS }] };
      hooks[event] = [...groups, newGroup];
      added.push(event);
      continue;
    }

    if (groups.length === 0) continue;
    let anyRemoved = false;
    const keptGroups: HookGroup[] = [];
    for (const group of groups) {
      const keptEntries = group.hooks.filter((entry) => !isOurCommand(entry, command));
      if (keptEntries.length !== group.hooks.length) anyRemoved = true;
      if (keptEntries.length > 0) keptGroups.push({ ...group, hooks: keptEntries });
    }
    if (!anyRemoved) continue;
    removed.push(event);
    if (keptGroups.length > 0) hooks[event] = keptGroups;
    else delete hooks[event];
  }

  if (Object.keys(hooks).length > 0) next.hooks = hooks;
  else delete next.hooks;

  return { next, added, removed };
}
