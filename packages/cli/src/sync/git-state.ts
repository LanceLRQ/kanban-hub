import type { GitState } from "@kanban-hub/core/schema";
import type { CliContext } from "../context";
import { runGit } from "../repo/git";

/** git log 用它把三个字段拼在一起再一次性解析，避免为了取标题、时间各跑一次命令；
 * 选一个不会出现在提交标题里的字符做分隔符 */
const FIELD_SEP = "\x1f";

function parseCount(text: string | undefined): number {
  const n = Number.parseInt((text ?? "").trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 采集某个目录的 git 状态：分支、HEAD、未提交改动数、与上游的 ahead/behind。
 * 不是 git 仓库时返回 null；仓库还没有提交时，head/headSubject/headAt 为 null，其余照常；
 * 没有配置上游分支时，ahead/behind 为 null。
 */
export async function collectGitState(ctx: CliContext, root: string): Promise<GitState | null> {
  const cwd = root;
  const env = ctx.env;

  const isRepo = await runGit(["rev-parse", "--is-inside-work-tree"], { cwd, env });
  if (!isRepo.ok || isRepo.stdout.trim() !== "true") return null;

  const branchResult = await runGit(["symbolic-ref", "--short", "-q", "HEAD"], { cwd, env });
  const branch = branchResult.ok ? branchResult.stdout.trim() : null;

  const logResult = await runGit(["log", "-1", `--format=%H${FIELD_SEP}%s${FIELD_SEP}%cI`], { cwd, env });
  let head: string | null = null;
  let headSubject: string | null = null;
  let headAt: string | null = null;
  if (logResult.ok) {
    const [h, subject, at] = logResult.stdout.replace(/\n$/, "").split(FIELD_SEP);
    head = h ?? null;
    headSubject = subject ?? null;
    headAt = at ?? null;
  }

  const statusResult = await runGit(["status", "--porcelain", "-z"], { cwd, env });
  const dirtyCount = statusResult.ok ? statusResult.stdout.split("\0").filter((entry) => entry !== "").length : 0;

  const revListResult = await runGit(["rev-list", "--left-right", "--count", "@{u}...HEAD"], { cwd, env });
  let ahead: number | null = null;
  let behind: number | null = null;
  if (revListResult.ok) {
    const [left, right] = revListResult.stdout.trim().split(/\s+/);
    behind = parseCount(left);
    ahead = parseCount(right);
  }

  return { branch, head, headSubject, headAt, dirtyCount, ahead, behind };
}
