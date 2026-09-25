import { runGit } from "./git";

/**
 * 项目指纹：git rev-list --max-parents=0 HEAD 的结果（可能有多个根提交，例如合并了无关历史）
 * 排序后取第一个。没有提交或不是 git 仓库时为 null。
 */
export async function fingerprint(root: string): Promise<string | null> {
  const result = await runGit(["rev-list", "--max-parents=0", "HEAD"], root);
  if (!result.ok) return null;

  const hashes = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .sort();
  return hashes[0] ?? null;
}
