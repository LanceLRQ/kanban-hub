import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface GitAuthor {
  name: string;
  email: string;
}

/** 作者与提交者的默认身份；提交者始终是它（规格 6.4） */
export const SYSTEM_IDENTITY: GitAuthor = { name: "kanban-hub", email: "kanban-hub@kanban-hub.local" };

const GIT_TIMEOUT_MS = 60_000;

// 每次调用都带上的配置：不签名；不在后台 gc（容器里脱离的后台进程会变成僵尸进程）；
// 数据目录的属主可能和运行身份不同（容器按 PUID 运行），而这个仓库只有 kanban-hub 自己写；
// 路径里的中文原样输出
const BASE_CONFIG = [
  "-c",
  "commit.gpgsign=false",
  "-c",
  "gc.autoDetach=false",
  "-c",
  "safe.directory=*",
  "-c",
  "core.quotePath=false",
];

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(`git ${args.join(" ")} 失败（退出码 ${exitCode ?? "无"}）：${stderr.trim()}`);
    this.name = "GitError";
  }
}

/** 调用 git 的环境：去掉继承来的 GIT_*（例如在 git hook 里运行时的 GIT_DIR），隔离用户的全局与系统配置 */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  return Object.assign(env, {
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: SYSTEM_IDENTITY.name,
    GIT_AUTHOR_EMAIL: SYSTEM_IDENTITY.email,
    GIT_COMMITTER_NAME: SYSTEM_IDENTITY.name,
    GIT_COMMITTER_EMAIL: SYSTEM_IDENTITY.email,
    LC_ALL: "C",
  });
}

function formatIdent(author: GitAuthor): string {
  const clean = (s: string) => s.replace(/[<>\r\n]/g, "").trim();
  return `${clean(author.name) || "unknown"} <${clean(author.email) || "unknown@kanban-hub.local"}>`;
}

/** 数据目录里的 git 仓库。身份与配置都由这里设置，不依赖入口脚本和用户的 git 配置 */
export class GitRepo {
  constructor(
    readonly dir: string,
    private readonly gitBin: string = "git",
  ) {}

  run(
    args: readonly string[],
    opts: { input?: string; okCodes?: readonly number[] } = {},
  ): Promise<{ stdout: string; code: number }> {
    const okCodes = opts.okCodes ?? [0];
    return new Promise((resolve, reject) => {
      const child = spawn(this.gitBin, [...BASE_CONFIG, ...args], { cwd: this.dir, env: gitEnv() });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), GIT_TIMEOUT_MS);
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.stdin.on("error", () => {}); // git 提前退出时写 stdin 会 EPIPE，结果以退出码为准
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new GitError(args, null, e.message));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== null && okCodes.includes(code)) resolve({ stdout, code });
        else reject(new GitError(args, code, stderr));
      });
      child.stdin.end(opts.input ?? "");
    });
  }

  async isRepo(): Promise<boolean> {
    try {
      await fs.access(path.join(this.dir, ".git"));
      return true;
    } catch {
      return false;
    }
  }

  /** 目录还不是 git 仓库时初始化，返回是否新建 */
  async init(): Promise<boolean> {
    if (await this.isRepo()) return false;
    await this.run(["init", "-q", "-b", "main"]);
    return true;
  }

  /**
   * 暂存指定文件（相对仓库根目录的 POSIX 路径）。
   * update-index 不解析通配符；已删除的文件会从索引移除，从未存在过的路径直接跳过。
   * 它不看 .gitignore，调用方不能把 auth/ 下的路径传进来。
   */
  async stageFiles(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.run(["update-index", "--add", "--remove", "-z", "--stdin"], {
      input: paths.map((p) => `${p}\0`).join(""),
    });
  }

  /** 暂存区与 HEAD 是否有差异（没有提交的新仓库与空树比较） */
  async hasStagedChanges(): Promise<boolean> {
    const { code } = await this.run(["diff", "--cached", "--quiet"], { okCodes: [0, 1] });
    return code === 1;
  }

  async commit(message: string, author: GitAuthor = SYSTEM_IDENTITY): Promise<void> {
    await this.run(["commit", "-q", "--no-verify", `--author=${formatIdent(author)}`, "-m", message]);
  }

  /**
   * 把工作区的全部改动提交一次，启动补提交用；没有改动返回 false。
   * exclude 里的路径不依赖 .gitignore，一定不会进这次提交——调用方用它兜底排除 auth/ 这类
   * 绝不能进 git 历史的目录，即使 .gitignore 被改动或丢失。
   * 实现上先 add 再 reset 撤回，不用 `:(exclude)<路径>` pathspec 直接排除：
   * 当排除的路径同时也被 .gitignore 忽略时（常态——auth/ 本来就在 .gitignore 里），
   * git 会把它当成“显式添加了被忽略的文件”，报 advice.addIgnoredFile 警告并以退出码 1 失败，
   * 即使实际效果是排除而不是添加（已用真实 git 验证）。
   */
  async commitAll(message: string, exclude: readonly string[] = []): Promise<boolean> {
    await this.run(["add", "-A", "--", "."]);
    if (exclude.length > 0) await this.run(["reset", "-q", "--", ...exclude]);
    if (!(await this.hasStagedChanges())) return false;
    await this.commit(message);
    return true;
  }
}
