import path from "node:path";
import type { CliContext } from "../context";
import { CliError, EXIT } from "../errors";
import { readRepoConfig, type RepoConfig } from "./config";
import { runGit } from "./git";

export interface RepoInspection {
  root: string;
  isGit: boolean;
  gitDir: string | null;
  commonDir: string | null;
  isLinkedWorktree: boolean;
}

/**
 * 探查 cwd 所在的 git 仓库：register 用来决定仓库根、判断是否链接工作树。
 * 不是 git 仓库时 root 就是 cwd 本身（register 用的仓库根：git 仓库取 show-toplevel，否则取当前目录）。
 */
export async function inspectRepo(cwd: string): Promise<RepoInspection> {
  const result = await runGit(["rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir"], cwd);
  if (!result.ok) {
    return { root: cwd, isGit: false, gitDir: null, commonDir: null, isLinkedWorktree: false };
  }

  const lines = result.stdout.split("\n").filter((line) => line !== "");
  const [root, gitDirRaw, commonDirRaw] = lines;
  if (root === undefined || gitDirRaw === undefined || commonDirRaw === undefined) {
    throw new CliError(EXIT.UNEXPECTED, "解析 git 仓库信息失败：git 输出的行数不符合预期");
  }

  // git-dir / git-common-dir 有时给相对路径，要按执行 git 时的工作目录（cwd）解析，不依赖 --path-format
  const gitDir = path.resolve(cwd, gitDirRaw);
  const commonDir = path.resolve(cwd, commonDirRaw);
  return { root, isGit: true, gitDir, commonDir, isLinkedWorktree: gitDir !== commonDir };
}

export interface RegisteredRepo {
  root: string;
  config: RepoConfig;
}

/**
 * 按“找仓库”的规则查找已注册的仓库：
 * - 在 git 仓库里：先看 show-toplevel，找不到且是链接工作树时再看主工作树根目录
 *   （仅当 git-common-dir 的目录名是 .git），不越过 git 顶层往上找（避免嵌套仓库误用外层项目）；
 * - 不在 git 仓库里：从 cwd 逐级向上找，到文件系统根目录或用户主目录（ctx.homeDir）为止。
 */
export async function findRegisteredRepo(cwd: string, ctx: CliContext): Promise<RegisteredRepo | null> {
  const inspection = await inspectRepo(cwd);

  if (inspection.isGit) {
    const direct = await readRepoConfig(inspection.root);
    if (direct !== null) return { root: inspection.root, config: direct };

    if (
      inspection.isLinkedWorktree &&
      inspection.commonDir !== null &&
      path.basename(inspection.commonDir) === ".git"
    ) {
      const mainRoot = path.dirname(inspection.commonDir);
      const fromMain = await readRepoConfig(mainRoot);
      if (fromMain !== null) return { root: mainRoot, config: fromMain };
    }
    return null;
  }

  let dir = cwd;
  for (;;) {
    const config = await readRepoConfig(dir);
    if (config !== null) return { root: dir, config };
    if (dir === ctx.homeDir) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** 把命令行里的路径（相对于 cwd，或绝对路径）换成仓库内的 POSIX 相对路径；落在仓库外抛用法错误 */
export function toRepoPath(root: string, cwd: string, input: string): string {
  const abs = path.resolve(cwd, input);
  const rel = path.relative(root, abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new CliError(EXIT.USAGE, `路径不在仓库内：${input}`, "请提供仓库内的路径");
  }
  return rel.split(path.sep).join("/");
}
