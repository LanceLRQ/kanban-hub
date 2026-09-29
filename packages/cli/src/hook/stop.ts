/**
 * kh hook stop：agent 每一轮回复结束时触发。先在后台启动同步（不等它），再判断要不要提醒上报：
 * 本次会话改动了仓库、却没有上报过进度时，向 stderr 写一段提醒，以退出码 2 结束（每个会话只提醒一次）。
 */
import { resolveKhHome } from "../config/home";
import { requireLogin } from "../commands/shared";
import { readLastReport } from "../report-log";
import type { RegisteredRepo } from "../repo/root";
import { isSyncLockBusy } from "../sync/lock";
import { snapshotRepoChanges, type RepoChanges } from "./changes";
import { describeHookError, HOOK_LIMITS, HookExit, type HookRun } from "./exit";
import { readHookInput, resolveHookRepo } from "./input";
import { gcMarkers, markReminded, readMarker, type SessionMarker } from "./marker";

export const STOP_REMINDER =
  "kanban-hub：本次会话改动了仓库，但还没有上报进度。请按 kanban-hub skill 用 kh task set / kh task add / kh log 更新进度；" +
  "如果确实没有需要上报的内容，可以直接结束。\n";

export interface ReminderInput {
  marker: SessionMarker | null;
  /** 当前仓库对应的项目 */
  projectId: string;
  stopHookActive: boolean;
  /** 本机在这个项目上最近一次成功上报的时间 */
  lastReport: () => Promise<Date | null>;
  /** 在标记记下的工作树里重新计算改动指纹；最费时，放在最后 */
  currentChanges: (marker: SessionMarker) => Promise<RepoChanges>;
}

/**
 * 按顺序判断四个条件，前一条不满足就不再往下算：
 * 1. 有这个会话的标记、还没提醒过、属于当前项目；2. 不是由上一次提醒引发的这一轮；
 * 3. 会话开始以来没有上报过；4. HEAD 或未提交改动与会话开始时不同。
 */
export async function shouldRemind(input: ReminderInput): Promise<boolean> {
  const { marker } = input;
  if (marker === null || marker.reminded || marker.projectId !== input.projectId) return false;
  if (input.stopHookActive) return false;
  const lastReport = await input.lastReport();
  if (lastReport !== null && lastReport.getTime() >= Date.parse(marker.startedAt)) return false;
  const changes = await input.currentChanges(marker);
  return changes.head !== marker.head || changes.dirty !== marker.dirty;
}

/** 已登录、能启动后台进程、同步锁不忙时，在后台启动 kh hook sync；任何失败都只记日志 */
async function startBackgroundSync(run: HookRun, repo: RegisteredRepo): Promise<void> {
  const { ctx, log } = run;
  try {
    await requireLogin(ctx, run.agentFlag);
  } catch (err) {
    log.write(`不启动后台同步：${describeHookError(err)}`);
    return;
  }
  if (ctx.spawnBackground === undefined || log.path === null) {
    log.write("当前环境无法启动后台进程，不启动后台同步");
    return;
  }
  try {
    if (await isSyncLockBusy(ctx, repo.config.projectId)) {
      log.write("另一个同步或拉取正在进行，本次不启动后台同步");
      return;
    }
    const args = ["hook", "sync", ...(run.agentFlag !== undefined ? ["--agent", run.agentFlag] : [])];
    ctx.spawnBackground(args, { cwd: repo.root, logFile: log.path });
    log.write("已在后台启动同步");
  } catch (err) {
    log.write(`后台启动同步失败：${describeHookError(err)}`);
  }
}

export async function runStopHook(run: HookRun): Promise<void> {
  const { ctx, log } = run;
  const input = await readHookInput(ctx, { timeoutMs: HOOK_LIMITS.stdinTimeoutMs, maxBytes: HOOK_LIMITS.stdinMaxBytes });
  if (input === null) {
    log.write("输入无效（不是合法的 JSON、缺少字段或 session_id 不合法），跳过");
    return;
  }
  const found = await resolveHookRepo(ctx, input);
  // 没接入的仓库：不输出、不写日志、不碰 KH_HOME
  if (found === null) return;

  const { repo } = found;
  const projectId = repo.config.projectId;
  log.setProject(projectId);
  const home = resolveKhHome(ctx);
  await gcMarkers(home, ctx.now());

  await startBackgroundSync(run, repo);

  const remind = await shouldRemind({
    marker: await readMarker(home, input.sessionId),
    projectId,
    stopHookActive: input.stopHookActive,
    lastReport: () => readLastReport(home, projectId),
    currentChanges: (marker) => snapshotRepoChanges(ctx, marker.worktree),
  });
  if (!remind) return;

  // 兜底时限已到时提醒不会再输出：这时不改标记，留给下一轮提醒
  if (!run.beginExit()) {
    log.write("已超过兜底时限，本轮不提醒");
    return;
  }
  // 先把标记改为已提醒再提醒：改不了就不提醒（否则每一轮都会重复提醒）
  await markReminded(home, input.sessionId);
  log.write("本次会话改动了仓库但还没有上报进度，已提醒");
  throw new HookExit(2, STOP_REMINDER);
}
