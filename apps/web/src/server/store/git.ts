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

/** 单次 git 调用的时间上限，超时后强杀 */
export const GIT_TIMEOUT_MS = 60_000;

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

export interface GitRepoOptions {
  /** 单次调用的时间上限，默认 GIT_TIMEOUT_MS */
  timeoutMs?: number;
}

/** 数据目录里的 git 仓库。身份与配置都由这里设置，不依赖入口脚本和用户的 git 配置 */
export class GitRepo {
  private readonly timeoutMs: number;

  constructor(
    readonly dir: string,
    private readonly gitBin: string = "git",
    opts: GitRepoOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;
  }

  run(
    args: readonly string[],
    opts: { input?: string; okCodes?: readonly number[] } = {},
  ): Promise<{ stdout: string; code: number }> {
    const okCodes = opts.okCodes ?? [0];
    return new Promise((resolve, reject) => {
      const child = spawn(this.gitBin, [...BASE_CONFIG, ...args], { cwd: this.dir, env: gitEnv() });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        // 超时：强杀之后不等输出管道关闭（git 派生的子进程可能还拿着管道），进程退出就收尾。
        // 数据目录的 git 调用只来自本进程且串行执行，被杀的这个进程留下的锁文件（index.lock、
        // HEAD.lock、refs 下的锁）不会是别人的，删掉它们，后续的提交才不会一直失败
        timedOut = true;
        child.stdout.destroy();
        child.stderr.destroy();
        const finish = () => {
          this.removeStaleLocks()
            .catch(() => {})
            .finally(() => settle(() => reject(new GitError(args, null, `超时（超过 ${this.timeoutMs} 毫秒未结束），已强制终止`))));
        };
        if (child.exitCode !== null || child.signalCode !== null) {
          finish();
        } else {
          child.once("exit", finish);
          child.kill("SIGKILL");
        }
      }, this.timeoutMs);
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.stdin.on("error", () => {}); // git 提前退出时写 stdin 会 EPIPE，结果以退出码为准
      child.on("error", (e) => settle(() => reject(new GitError(args, null, e.message))));
      child.on("close", (code) => {
        // 超时的收尾由上面的定时器负责：要等删掉 index.lock 之后才能结束
        if (timedOut) return;
        settle(() => {
          if (code !== null && okCodes.includes(code)) resolve({ stdout, code });
          else reject(new GitError(args, code, stderr));
        });
      });
      child.stdin.end(opts.input ?? "");
    });
  }

  /**
   * 删除进程被强杀时留下的锁文件：index.lock、HEAD.lock，以及 refs 下的 *.lock。
   * 只在没有别的 git 进程运行时调用：启动时，或者本进程唯一的 git 调用超时被强杀之后。
   */
  async removeStaleLocks(): Promise<void> {
    const gitDir = path.join(this.dir, ".git");
    await fs.rm(path.join(gitDir, "index.lock"), { force: true });
    await fs.rm(path.join(gitDir, "HEAD.lock"), { force: true });
    let entries;
    try {
      entries = await fs.readdir(path.join(gitDir, "refs"), { recursive: true, withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".lock")) await fs.rm(path.join(entry.parentPath, entry.name), { force: true });
    }
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
   * forceInclude 里的路径（存在时）再用 add -f 纳入一遍，不受任何 .gitignore 影响——
   * 数据目录里保存的文件可能自带 .gitignore，它的规则不能让这些文件漏提交。
   */
  async commitAll(message: string, exclude: readonly string[] = [], forceInclude: readonly string[] = []): Promise<boolean> {
    await this.run(["add", "-A", "--", "."]);
    const forced: string[] = [];
    for (const p of forceInclude) {
      if (await pathExists(path.join(this.dir, ...p.split("/")))) forced.push(p);
    }
    if (forced.length > 0) await this.run(["add", "-A", "-f", "--", ...forced]);
    if (exclude.length > 0) await this.run(["reset", "-q", "--", ...exclude]);
    if (!(await this.hasStagedChanges())) return false;
    await this.commit(message);
    return true;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
