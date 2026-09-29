import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { CliContext } from "../context";
import { runGit } from "../repo/git";

export interface RepoChanges {
  /** HEAD 提交；不是 git 仓库或还没有提交时为 null */
  head: string | null;
  /** 未提交改动的指纹（含被删除文件的信息）；不是 git 仓库时为 null */
  dirty: string | null;
}

/**
 * 在 worktree 的顶层计算改动指纹：head 取 `git rev-parse HEAD`；dirty 汇总
 * `git status --porcelain=v1 -z --untracked-files=all --no-renames` 列出的每一项，
 * 再加上当前文件的大小、mtime（这样会话开始前已经改过的文件再被改一次，也能被发现），
 * 排序后算 sha256。不是 git 仓库时两者都是 null；被 git 忽略的文件不计入（默认不列出）。
 */
export async function snapshotRepoChanges(ctx: CliContext, worktree: string): Promise<RepoChanges> {
  const statusResult = await runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], {
    cwd: worktree,
    env: ctx.env,
  });
  if (!statusResult.ok) {
    return { head: null, dirty: null };
  }

  const headResult = await runGit(["rev-parse", "HEAD"], { cwd: worktree, env: ctx.env });
  const head = headResult.ok ? headResult.stdout.trim() : null;
  const dirty = await computeDirtyDigest(statusResult.stdout, worktree);
  return { head, dirty };
}

/** git status -z 的输出按 NUL 分隔，每一项是 "XY路径"（两个状态字符 + 空格 + 路径） */
function parseStatusEntries(output: string): string[] {
  return output.split("\0").filter((entry) => entry.length > 0);
}

async function computeDirtyDigest(statusOutput: string, worktree: string): Promise<string> {
  const entries = parseStatusEntries(statusOutput);
  const items = await Promise.all(
    entries.map(async (entry) => {
      const status = entry.slice(0, 2);
      const filePath = entry.slice(3);
      let size = "-";
      let mtime = "-";
      try {
        const stat = await fs.stat(path.join(worktree, filePath));
        size = String(stat.size);
        mtime = String(stat.mtimeMs);
      } catch {
        // 文件已经被删除：大小、mtime 取不到，记为 "-"，不报错
      }
      return `${status}\u0000${filePath}\u0000${size}\u0000${mtime}`;
    }),
  );
  items.sort();

  const hash = createHash("sha256");
  for (const item of items) hash.update(item);
  return hash.digest("hex");
}
