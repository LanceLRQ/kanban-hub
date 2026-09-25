import path from "node:path";
import type { CliContext } from "../context";
import { resolveKhHome } from "../config/home";
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
 * 本机配置目录（KH_HOME）和某个候选仓库根的 .kanban-hub 是不是同一个文件：默认 KH_HOME
 * 是主目录下的 .kanban-hub，如果仓库根恰好是主目录本身（例如把整个主目录纳入 git 管理，
 * 或者在主目录本身执行命令），两者会撞成同一个文件。跳过这个候选目录，否则会把本机配置
 * 误读成仓库配置，或者反过来把仓库配置写坏本机配置。两边都用 path.resolve 统一成绝对路径
 * 再比较，不做 fs.realpath（KH_HOME 可能还不存在，realpath 会失败）。
 */
export function collidesWithKhHome(candidateRoot: string, ctx: CliContext): boolean {
  let khHome: string;
  try {
    khHome = resolveKhHome(ctx);
  } catch {
    // KH_HOME 解析失败（比如取不到主目录）不该在这里报错，交给真正需要它的调用方处理
    return false;
  }
  return path.resolve(candidateRoot, ".kanban-hub") === path.resolve(khHome);
}

/**
 * git 仓库分支的“找已注册配置”规则：先看 show-toplevel，找不到且是链接工作树时再看
 * 主工作树根目录（仅当 git-common-dir 的目录名是 .git），不越过 git 顶层往上找（避免
 * 嵌套仓库误用外层项目）；两处都跳过“候选目录的 .kanban-hub 恰好是 KH_HOME”的情况。
 *
 * findRegisteredRepo（status、task 等只读命令）和 register 共用这份逻辑：register 判断
 * “已有配置”只看当前这一层、不像非 git 分支那样往上找祖先目录（避免子目录的 --new 被
 * 父项目的配置吞掉），但 git 仓库的“当前这一层”本来就包含“链接工作树背后的主工作树”——
 * 主工作树已经注册时，在链接工作树里执行 register 应该看到这个事实，而不是因为看不到就
 * 走全新注册、按指纹绑定同一个项目、再用工作树自己的路径把本机在主工作树上登记的位置覆盖掉
 * （每台机器每个项目只有一个位置）。
 */
export async function findRegisteredRepoInGit(inspection: RepoInspection, ctx: CliContext): Promise<RegisteredRepo | null> {
  if (!collidesWithKhHome(inspection.root, ctx)) {
    const direct = await readRepoConfig(inspection.root);
    if (direct !== null) return { root: inspection.root, config: direct };
  }

  if (inspection.isLinkedWorktree && inspection.commonDir !== null && path.basename(inspection.commonDir) === ".git") {
    const mainRoot = path.dirname(inspection.commonDir);
    if (!collidesWithKhHome(mainRoot, ctx)) {
      const fromMain = await readRepoConfig(mainRoot);
      if (fromMain !== null) return { root: mainRoot, config: fromMain };
    }
  }
  return null;
}

/**
 * 按“找仓库”的规则查找已注册的仓库：
 * - 在 git 仓库里：见 findRegisteredRepoInGit；
 * - 不在 git 仓库里：从 cwd 逐级向上找，到文件系统根目录或用户主目录（ctx.homeDir）为止，
 *   同样跳过“候选目录的 .kanban-hub 恰好是 KH_HOME”的情况，见 collidesWithKhHome。
 */
export async function findRegisteredRepo(cwd: string, ctx: CliContext): Promise<RegisteredRepo | null> {
  const inspection = await inspectRepo(cwd);

  if (inspection.isGit) {
    return findRegisteredRepoInGit(inspection, ctx);
  }

  let dir = cwd;
  for (;;) {
    if (collidesWithKhHome(dir, ctx)) {
      if (dir === ctx.homeDir) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
      continue;
    }
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
