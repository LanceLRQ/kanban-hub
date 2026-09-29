import type { GitState } from "@kanban-hub/core/schema";
import type { CliContext } from "../context";
import { CliError, EXIT } from "../errors";
import { runGit } from "../repo/git";
import { inspectRepo } from "../repo/root";

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

/**
 * 路径的比较键：先规范化成 NFC 再转小写，与 core 判定路径冲突时的规则一致。大小写不敏感、
 * 对 Unicode 规范化形式不敏感的文件系统（例如 macOS）上，只差这两点的路径是同一个文件。
 */
export function pathKey(p: string): string {
  return p.normalize("NFC").toLowerCase();
}

/**
 * 本机被 git 跟踪的路径（git ls-files -z），用于跳过它们：比较时不区分大小写和 Unicode 规范化形式
 * （见 pathKey）；某一级父路径被跟踪（例如子模块）也算被跟踪。
 * 不是 git 仓库时为空；是 git 仓库但读取失败时报错，不在不知道哪些文件被跟踪的情况下写入。
 */
export async function listTrackedPaths(ctx: CliContext, root: string): Promise<(relPath: string) => boolean> {
  const inspection = await inspectRepo(root, ctx.env);
  if (!inspection.isGit) return () => false;
  const result = await runGit(["ls-files", "-z"], { cwd: root, env: ctx.env, buffer: true });
  if (!result.ok) {
    throw new CliError(EXIT.UNEXPECTED, `读取被 git 跟踪的文件列表失败：${result.stderr.trim()}`);
  }
  const tracked = new Set(
    result.stdout
      .toString("utf8")
      .split("\0")
      .filter((p) => p !== "")
      .map(pathKey),
  );
  return (relPath) => {
    const segs = pathKey(relPath).split("/");
    for (let i = 1; i <= segs.length; i++) {
      if (tracked.has(segs.slice(0, i).join("/"))) return true;
    }
    return false;
  };
}
