/**
 * kh hook sync：Stop hook 在后台启动的内部命令。与 kh sync 调用同一个推送函数，区别在于：
 * 清单没有变化且距上次推送不到 10 分钟时不联网直接结束；结果和错误只写 hook.log；
 * 不记上报时间（同步不算上报）。
 */
import { resolveKhHome } from "../config/home";
import { requireLogin } from "../commands/shared";
import { findRegisteredRepo } from "../repo/root";
import { isSyncLockBusy, isSyncLockBusyError } from "../sync/lock";
import { pushDocs, type PushResult } from "../sync/push";
import { describeHookError, HOOK_LIMITS, type HookRun } from "./exit";
import { gcMarkers } from "./marker";

function describePush(result: PushResult): string {
  if (result.skippedUnchanged) return "没有变化，跳过";
  const items: [string, number][] = [
    ["新增", result.added],
    ["修改", result.modified],
    ["删除", result.removed],
  ];
  const nonZero = items.filter(([, n]) => n > 0);
  return nonZero.length === 0 ? "已同步：没有变化" : `已同步：${nonZero.map(([label, n]) => `${label} ${n}`).join("、")}`;
}

export async function runBackgroundSync(run: HookRun): Promise<void> {
  const { ctx, log } = run;
  const repo = await findRegisteredRepo(ctx.cwd, ctx);
  if (repo === null) return;

  log.setProject(repo.config.projectId);
  await gcMarkers(resolveKhHome(ctx), ctx.now());

  let client;
  try {
    ({ client } = await requireLogin(ctx, run.agentFlag));
  } catch (err) {
    log.write(`同步失败：${describeHookError(err)}`);
    return;
  }

  try {
    // 被占用就直接跳过，不像手动命令那样等待；两次检查之间被抢走的情况由下面的 catch 兜住
    if (await isSyncLockBusy(ctx, repo.config.projectId)) {
      log.write("另一个同步或拉取正在进行，跳过");
      return;
    }
    const result = await pushDocs(ctx, repo, client, { quiet: true, skipIfUnchangedWithinMs: HOOK_LIMITS.pushSkipWindowMs });
    log.write(describePush(result));
  } catch (err) {
    log.write(isSyncLockBusyError(err) ? "另一个同步或拉取正在进行，跳过" : `同步失败：${describeHookError(err)}`);
  }
}
