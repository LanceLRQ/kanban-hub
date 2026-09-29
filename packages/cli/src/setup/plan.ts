import fs from "node:fs/promises";
import path from "node:path";
import type { CliContext } from "../context";
import { CliError, EXIT } from "../errors";
import { readMachineConfig, resolveKhHome } from "../config/home";
import { isNoEntError, writeFileAtomic, type WriteFileAtomicOptions } from "../fs-utils";
import { mergeClaudeHooks } from "./claude-settings";
import { SKILL_MD } from "./skill";

type SkillAction = "create" | "update" | "remove" | "skip";
type SettingsAction = "create" | "update" | "skip";

export interface SkillPlan {
  /** 要写入或删除的路径 */
  path: string;
  action: SkillAction;
  /** 安装模式下要写入的正文；卸载模式下也带着（未使用），方便测试比对 */
  content: string;
}

export interface ClaudeSettingsPlan {
  /** ~/.claude/settings.json 的路径（可能是软链接） */
  linkPath: string;
  /** 实际要读写的路径：linkPath 是软链接时是 realpath 之后的目标，否则等于 linkPath */
  realPath: string;
  isSymlink: boolean;
  action: SettingsAction;
  added: string[];
  removed: string[];
  /** 要写入的完整文件内容；action 为 skip 时为 null */
  nextContent: string | null;
  /** 原文件内容；文件不存在时为 null */
  originalRaw: string | null;
  /** 原文件权限位；文件不存在时为 null，写入时据此保留权限 */
  originalMode: number | null;
  /** 备份文件的完整路径；不需要备份（没有变化，或原文件不存在）时为 null */
  backupPath: string | null;
}

export interface SetupPlan {
  uninstall: boolean;
  /** 总是写：~/.agents/skills/kanban-hub/SKILL.md */
  agentSkill: SkillPlan;
  /** 主目录下是否存在 .claude/ */
  claudeDirExists: boolean;
  /** claudeDirExists 为 false 时为 null */
  claudeSkill: SkillPlan | null;
  /** claudeDirExists 为 false 时为 null */
  claudeSettings: ClaudeSettingsPlan | null;
  /** 本机是否已登录，仅用于提示文案 */
  loggedIn: boolean;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch (err) {
    if (isNoEntError(err)) return false;
    throw err;
  }
}

async function readFileIfExists(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf8");
  } catch (err) {
    if (isNoEntError(err)) return null;
    throw err;
  }
}

/** skill 文件的落地计划：安装时新建/更新/内容相同，卸载时删除/无需处理 */
async function planSkillFile(filePath: string, uninstall: boolean): Promise<SkillPlan> {
  const existing = await readFileIfExists(filePath);
  if (uninstall) {
    return { path: filePath, action: existing === null ? "skip" : "remove", content: SKILL_MD };
  }
  if (existing === null) return { path: filePath, action: "create", content: SKILL_MD };
  return { path: filePath, action: existing === SKILL_MD ? "skip" : "update", content: SKILL_MD };
}

/** 去掉开头的 BOM，空内容（或只有空白）当作 "{}"，其余按 JSON 解析；解析失败拒绝整个 setup */
function parseSettingsContent(raw: string | null, displayPath: string): unknown {
  if (raw === null) return {};
  const stripped = raw.replace(/^\uFEFF/, "");
  if (stripped.trim() === "") return {};
  try {
    return JSON.parse(stripped);
  } catch {
    throw new CliError(EXIT.DATA, `settings.json 不是合法的 JSON：${displayPath}`, "手动修复该文件后重新执行 kh setup");
  }
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** 备份文件名的时间戳部分：本机时区的 YYYYMMDD-HHmmss */
function formatBackupStamp(now: Date): string {
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** 在目标文件所在目录里找一个不冲突的备份文件名；同名已存在时依次加 -1、-2…… */
async function resolveBackupPath(target: string, now: Date): Promise<string> {
  const stamp = formatBackupStamp(now);
  const dir = path.dirname(target);
  const base = path.basename(target);
  let candidate = path.join(dir, `${base}.bak-${stamp}`);
  let seq = 1;
  while (await pathExists(candidate)) {
    candidate = path.join(dir, `${base}.bak-${stamp}-${seq}`);
    seq += 1;
  }
  return candidate;
}

/** ~/.claude/settings.json 的落地计划；软链接时读写 realpath 之后的目标，备份放在目标旁边 */
async function planClaudeSettings(claudeDir: string, uninstall: boolean, now: Date): Promise<ClaudeSettingsPlan> {
  const linkPath = path.join(claudeDir, "settings.json");

  let isSymlink = false;
  let realPath = linkPath;
  try {
    const lst = await fs.lstat(linkPath);
    isSymlink = lst.isSymbolicLink();
  } catch (err) {
    if (!isNoEntError(err)) throw err;
  }
  if (isSymlink) {
    try {
      realPath = await fs.realpath(linkPath);
    } catch (err) {
      if (!isNoEntError(err)) throw err;
      // 悬空链接（例如 dotfiles 仓库还没 clone）：原子写会用普通文件把链接换掉，所以安装时拒绝；
      // 卸载时没有可移除的 hook，当作文件不存在、跳过即可
      if (!uninstall) {
        const target = path.resolve(claudeDir, await fs.readlink(linkPath));
        throw new CliError(
          EXIT.DATA,
          `settings.json 是软链接，但指向的文件不存在：${linkPath} → ${target}`,
          "先恢复链接指向的文件（或删掉这个链接）后重新执行 kh setup",
        );
      }
      return { linkPath, realPath, isSymlink, action: "skip", added: [], removed: [], nextContent: null, originalRaw: null, originalMode: null, backupPath: null };
    }
  }

  let originalMode: number | null = null;
  let originalRaw: string | null = null;
  try {
    const stat = await fs.stat(realPath);
    originalMode = stat.mode & 0o777;
    originalRaw = await fs.readFile(realPath, "utf8");
  } catch (err) {
    if (!isNoEntError(err)) throw err;
  }

  const parsed = parseSettingsContent(originalRaw, realPath);
  const { next, added, removed } = mergeClaudeHooks(parsed, uninstall ? "uninstall" : "install");

  if (added.length === 0 && removed.length === 0) {
    return { linkPath, realPath, isSymlink, action: "skip", added, removed, nextContent: null, originalRaw, originalMode, backupPath: null };
  }

  const nextContent = `${JSON.stringify(next, null, 2)}\n`;
  const backupPath = originalRaw === null ? null : await resolveBackupPath(realPath, now);
  const action: SettingsAction = originalRaw === null ? "create" : "update";
  return { linkPath, realPath, isSymlink, action, added, removed, nextContent, originalRaw, originalMode, backupPath };
}

/** 本机是否已登录：只用于提示文案，不做副作用（不修复凭据文件权限、不输出警告） */
async function checkLoggedIn(ctx: CliContext): Promise<boolean> {
  try {
    const home = resolveKhHome(ctx);
    const cfg = await readMachineConfig(home);
    if (cfg === null || cfg.machineId === undefined) return false;
    await fs.access(path.join(home, "credentials"));
    return true;
  } catch {
    return false;
  }
}

/** 算出 kh setup 要做的全部改动；不写入任何文件（读取是安全的） */
export async function planSetup(ctx: CliContext, opts: { uninstall: boolean }): Promise<SetupPlan> {
  const homeDir = ctx.homeDir;
  if (homeDir === "" || !path.isAbsolute(homeDir)) {
    throw new CliError(EXIT.UNEXPECTED, "找不到当前用户的主目录", "可以设置环境变量 KH_HOME 指定 kh 的本机数据目录");
  }

  const agentSkillPath = path.join(homeDir, ".agents", "skills", "kanban-hub", "SKILL.md");
  const agentSkill = await planSkillFile(agentSkillPath, opts.uninstall);

  const claudeDir = path.join(homeDir, ".claude");
  const claudeDirExists = await pathExists(claudeDir);

  let claudeSkill: SkillPlan | null = null;
  let claudeSettings: ClaudeSettingsPlan | null = null;
  if (claudeDirExists) {
    const claudeSkillPath = path.join(claudeDir, "skills", "kanban-hub", "SKILL.md");
    claudeSkill = await planSkillFile(claudeSkillPath, opts.uninstall);
    claudeSettings = await planClaudeSettings(claudeDir, opts.uninstall, ctx.now());
  }

  const loggedIn = await checkLoggedIn(ctx);

  return { uninstall: opts.uninstall, agentSkill, claudeDirExists, claudeSkill, claudeSettings, loggedIn };
}

async function removeDirIfEmpty(dir: string): Promise<void> {
  try {
    const entries = await fs.readdir(dir);
    if (entries.length === 0) await fs.rmdir(dir);
  } catch (err) {
    if (!isNoEntError(err)) throw err;
  }
}

async function applySkillPlan(skill: SkillPlan): Promise<void> {
  if (skill.action === "skip") return;
  if (skill.action === "remove") {
    await fs.rm(skill.path, { force: true });
    await removeDirIfEmpty(path.dirname(skill.path));
    return;
  }
  await writeFileAtomic(skill.path, skill.content, { mkdir: true });
}

async function applyClaudeSettingsPlan(settings: ClaudeSettingsPlan): Promise<void> {
  if (settings.action === "skip") return;

  // 顺序固定：先备份、再写回。备份失败时原文件保持不变；写回本身是原子写（临时文件 + rename），
  // 写到一半失败也不会破坏原文件。
  if (settings.backupPath !== null && settings.originalRaw !== null) {
    const backupOpts: WriteFileAtomicOptions = settings.originalMode !== null ? { mode: settings.originalMode } : {};
    await writeFileAtomic(settings.backupPath, settings.originalRaw, backupOpts);
  }

  const writeOpts: WriteFileAtomicOptions = { mkdir: true };
  if (settings.originalMode !== null) writeOpts.mode = settings.originalMode;
  await writeFileAtomic(settings.realPath, settings.nextContent!, writeOpts);
}

/** 计划里 settings.json 的内容与现在磁盘上的是否已经不同（例如等待确认期间 Claude Code 改写了它） */
async function settingsChangedSincePlan(settings: ClaudeSettingsPlan): Promise<boolean> {
  return (await readFileIfExists(settings.realPath)) !== settings.originalRaw;
}

/**
 * 按计划执行：写 skill、合并并写回 settings.json（含备份）。计划里已经决定好的 skip 项不做任何 IO。
 * 写之前先重读 settings.json：与计划时读到的不同，就基于最新内容重新合并（用户确认的是“加上或去掉本工具的两个
 * hook”，不是某一份旧内容），备份也存最新内容，不会把别人在这期间做的改动回滚掉。重新合并在写任何文件之前完成，
 * 最新内容结构不对时整个执行什么都不写。返回实际执行的计划。
 */
export async function applySetup(ctx: CliContext, plan: SetupPlan): Promise<SetupPlan> {
  let effective = plan;
  if (plan.claudeSettings !== null && (await settingsChangedSincePlan(plan.claudeSettings))) {
    const claudeDir = path.dirname(plan.claudeSettings.linkPath);
    const claudeSettings = await planClaudeSettings(claudeDir, plan.uninstall, ctx.now());
    effective = { ...plan, claudeSettings };
    ctx.stdout.write("settings.json 在确认期间有变化，已按最新内容重新合并。\n");
  }

  await applySkillPlan(effective.agentSkill);
  if (effective.claudeSkill !== null) await applySkillPlan(effective.claudeSkill);
  if (effective.claudeSettings !== null) await applyClaudeSettingsPlan(effective.claudeSettings);
  return effective;
}

function skillActionLabel(action: SkillAction): string {
  switch (action) {
    case "create":
      return "新建";
    case "update":
      return "更新";
    case "remove":
      return "删除";
    case "skip":
      return "内容相同，跳过";
  }
}

function renderSkillLine(label: string, skill: SkillPlan): string {
  return `${label}：${skillActionLabel(skill.action)} ${skill.path}`;
}

function renderSettingsLines(settings: ClaudeSettingsPlan): string[] {
  const target = settings.isSymlink ? `${settings.linkPath} → ${settings.realPath}` : settings.realPath;
  if (settings.action === "skip") {
    const label = settings.added.length === 0 && settings.removed.length === 0 ? "已安装，跳过" : "跳过";
    return [`Claude Code 配置：${label} ${target}`];
  }
  const lines = [`Claude Code 配置：${settings.action === "create" ? "新建" : "更新"} ${target}`];
  if (settings.added.length > 0) lines.push(`  添加 hook：${settings.added.join("、")}`);
  if (settings.removed.length > 0) lines.push(`  移除 hook：${settings.removed.join("、")}`);
  if (settings.backupPath !== null) lines.push(`  备份文件：${settings.backupPath}`);
  return lines;
}

/** 把计划渲染成给用户看的文本：--dry-run 直接打印这份，正常流程确认前也先打印这份 */
export function renderSetupPlan(plan: SetupPlan): string {
  const lines: string[] = [plan.uninstall ? "动作：卸载 kanban-hub 的 skill 与 hook" : "动作：安装或更新 kanban-hub 的 skill 与 hook"];
  lines.push(renderSkillLine("通用 skill", plan.agentSkill));

  if (plan.claudeDirExists) {
    lines.push(renderSkillLine("Claude Code skill", plan.claudeSkill!));
    lines.push(...renderSettingsLines(plan.claudeSettings!));
  } else {
    lines.push("未检测到 ~/.claude/，跳过 Claude Code 的 skill 与 hook");
  }

  if (!plan.loggedIn) {
    lines.push("提示：本机还没有登录，hook 运行时不会做任何事，请先执行 kh login");
  }

  return lines.join("\n");
}
