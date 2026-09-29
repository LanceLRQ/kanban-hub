/**
 * kh hook session-start：agent 会话开始（含恢复、清空、压缩之后）时触发。
 * 自动拉取其他机器的文档、取项目进度，向 stdout 输出进度摘要；最后记下会话标记
 * （放在拉取之后，拉下来的文件不算本次会话的改动）。任何失败都只写日志。
 */
import type { ProjectDetailResponse } from "@kanban-hub/core/api";
import { resolveKhHome } from "../config/home";
import { loadProject, requireLogin, type LoggedIn } from "../commands/shared";
import { CliError, EXIT } from "../errors";
import type { RegisteredRepo } from "../repo/root";
import { buildStatusView } from "../status/view";
import { isSyncLockBusy, isSyncLockBusyError } from "../sync/lock";
import { partialPullResultOf, pullDocs } from "../sync/pull";
import { openSyncState } from "../sync/state";
import { snapshotRepoChanges } from "./changes";
import { describeHookError, HOOK_LIMITS, type HookRun } from "./exit";
import { readHookInput, resolveHookRepo } from "./input";
import { createMarkerIfAbsent, gcMarkers } from "./marker";
import { renderSessionSummary, type SessionPull, type SessionSummaryInput } from "./summary";

/**
 * 把拉取的错误归类：锁被占用；其他机器都还没有同步过（kh 本地构造的退出码 5：没有 HTTP
 * 状态码，也没有完成任何文件）；其余都是失败，已完成的部分照常带上。
 */
export function classifyPullError(err: unknown): SessionPull {
  if (isSyncLockBusyError(err)) return { kind: "busy" };
  const partial = partialPullResultOf(err);
  if (err instanceof CliError && err.exitCode === EXIT.DATA && err.status === undefined && partial === null) {
    return { kind: "none" };
  }
  return { kind: "failed", message: describeHookError(err), partial };
}

async function autoPull(run: HookRun, repo: RegisteredRepo, loggedIn: LoggedIn): Promise<SessionPull> {
  if (!repo.config.pull.auto) return { kind: "off" };
  try {
    // 被占用就直接跳过，不像手动命令那样等待
    if (await isSyncLockBusy(run.ctx, repo.config.projectId)) return { kind: "busy" };
    const result = await pullDocs(run.ctx, repo, loggedIn.client.withTimeout(HOOK_LIMITS.pullRequestTimeoutMs), {
      dryRun: false,
      deadline: run.startedAt + HOOK_LIMITS.pullDeadlineMs,
    });
    return { kind: "done", result };
  } catch (err) {
    return classifyPullError(err);
  }
}

type DetailOutcome = { ok: true; detail: ProjectDetailResponse } | { ok: false; reason: string };

async function loadDetail(loggedIn: LoggedIn, projectId: string): Promise<DetailOutcome> {
  try {
    return { ok: true, detail: await loadProject(loggedIn.client.withTimeout(HOOK_LIMITS.detailTimeoutMs), projectId) };
  } catch (err) {
    return { ok: false, reason: describeHookError(err) };
  }
}

/** 本机登记的未解决冲突（离线可读）；读不出来就当作没有 */
async function readConflicts(run: HookRun, repo: RegisteredRepo): Promise<SessionSummaryInput["conflicts"]> {
  try {
    const state = await openSyncState(run.ctx, repo.config.projectId, repo.root);
    return [...state.conflicts.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, record]) => ({ path, machineName: record.remoteMachineName ?? record.remoteMachineId }));
  } catch (err) {
    run.log.write(`读取本机冲突记录失败：${describeHookError(err)}`);
    return [];
  }
}

function describePullForLog(pull: SessionPull): string {
  switch (pull.kind) {
    case "off":
      return "自动拉取：未开启";
    case "none":
      return "自动拉取：其他机器还没有同步过";
    case "busy":
      return "自动拉取：另一个同步或拉取正在进行，跳过";
    case "done": {
      const r = pull.result;
      return `自动拉取：新建 ${r.created.length}、覆盖 ${r.overwritten.length}、自动合并 ${r.merged.length}、冲突 ${r.conflicts.length}${r.timedOut ? "，已超时" : ""}`;
    }
    case "failed":
      return `自动拉取失败：${pull.message}`;
  }
}

export async function runSessionStartHook(run: HookRun): Promise<void> {
  const { ctx, log } = run;
  const input = await readHookInput(ctx, { timeoutMs: HOOK_LIMITS.stdinTimeoutMs, maxBytes: HOOK_LIMITS.stdinMaxBytes });
  if (input === null) {
    log.write("输入无效（不是合法的 JSON、缺少字段或 session_id 不合法），跳过");
    return;
  }
  const found = await resolveHookRepo(ctx, input);
  // 没接入的仓库：不输出、不写日志、不碰 KH_HOME
  if (found === null) return;

  const { repo, worktree } = found;
  const projectId = repo.config.projectId;
  log.setProject(projectId);
  const home = resolveKhHome(ctx);
  await gcMarkers(home, ctx.now());

  let loggedIn: LoggedIn;
  try {
    loggedIn = await requireLogin(ctx, run.agentFlag);
  } catch (err) {
    log.write(`跳过：${describeHookError(err)}`);
    return;
  }

  const [detail, pull] = await Promise.all([loadDetail(loggedIn, projectId), autoPull(run, repo, loggedIn)]);

  if (detail.ok) {
    const view = buildStatusView(detail.detail, { machineId: loggedIn.machine.id, now: ctx.now() });
    const conflicts = await readConflicts(run, repo);
    run.emit(renderSessionSummary({ view, pull, conflicts }));
  } else {
    // 服务端连不上时完全不输出，只记日志
    log.write(`取项目进度失败，不输出摘要：${detail.reason}`);
  }

  try {
    const changes = await snapshotRepoChanges(ctx, worktree);
    await createMarkerIfAbsent(home, {
      sessionId: input.sessionId,
      projectId,
      root: repo.root,
      worktree,
      startedAt: new Date(run.startedAt).toISOString(),
      head: changes.head,
      dirty: changes.dirty,
      reminded: false,
    });
  } catch (err) {
    log.write(`记录会话标记失败：${describeHookError(err)}`);
  }

  log.write(describePullForLog(pull));
}
