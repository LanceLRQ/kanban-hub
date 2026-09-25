/**
 * kh 端到端测试的公共夹具：驱动 cli 的 main()（不 spawn 真实进程，除非测试明确需要验证
 * 真实进程的退出码），以及造临时仓库、临时 KH_HOME。
 *
 * 临时目录一律先 fs.realpath 再交给调用方：macOS 的 os.tmpdir() 落在 /var，实际是
 * /private/var 的软链接，而 git 输出的是解析后的物理路径，混用会让仓库内路径的换算出错
 * （控制者裁决，见 04-M3-kh基础命令/context.md）。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { CliContext } from "../../../../packages/cli/src/context";
import { main } from "../../../../packages/cli/src/main";

const GIT_TEST_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

const IDENTITY_ARGS = ["-c", "user.name=kh-e2e", "-c", "user.email=kh-e2e@example.com", "-c", "commit.gpgsign=false"];

/** 在给定目录下执行 git（固定测试身份、不弹交互式签名、不受开发机全局配置影响） */
function gitFixture(args: string[], cwd: string): string {
  return execFileSync("git", [...IDENTITY_ARGS, ...args], { cwd, env: GIT_TEST_ENV, encoding: "utf8", stdio: "pipe" });
}

async function makeRealTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return fs.realpath(dir);
}

export interface TempDir {
  dir: string;
  cleanup(): Promise<void>;
}

export interface MakeTempRepoOptions {
  /** 初始提交数，默认 1；每次提交都记一个 hash，方便测试用第一个提交做 fingerprint */
  commits?: number;
  /** 是否要 git init，默认 true；传 false 得到一个不是 git 仓库的空目录 */
  git?: boolean;
}

export interface TempRepo extends TempDir {
  /** 按提交顺序排列的提交 hash；git 为 false 时是空数组 */
  commitHashes: string[];
}

/** 建一个临时仓库；git 默认为 true 时会 init 并按 commits 数量提交（默认 1 个空提交） */
export async function makeTempRepo(opts: MakeTempRepoOptions = {}): Promise<TempRepo> {
  const { commits = 1, git = true } = opts;
  const dir = await makeRealTempDir("kh-e2e-repo-");
  const commitHashes: string[] = [];
  if (git) {
    gitFixture(["init", "-q"], dir);
    for (let i = 0; i < commits; i++) {
      gitFixture(["commit", "--allow-empty", "-q", "-m", `commit ${i + 1}`], dir);
      commitHashes.push(gitFixture(["rev-parse", "HEAD"], dir).trim());
    }
  }
  return { dir, commitHashes, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

/** 建一个空的临时目录当 KH_HOME 用（runKh 需要一个隔离的本机数据目录） */
export async function makeTempKhHome(): Promise<TempDir> {
  const dir = await makeRealTempDir("kh-e2e-home-");
  return { dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

/** 统一清理多个临时目录（makeTempRepo / makeTempKhHome 的返回值），失败互不影响 */
export async function cleanupAll(...items: readonly TempDir[]): Promise<void> {
  await Promise.all(items.map((item) => item.cleanup()));
}

export interface RunKhOptions {
  cwd: string;
  khHome: string;
  /** 额外的环境变量；KH_HOME 由 khHome 决定，这里传了也会被覆盖 */
  env?: Record<string, string | undefined>;
  /** 交互式确认要读的输入；省略时 stdin 视为立即 EOF（空输入） */
  stdin?: string;
  isTTY?: boolean;
}

export interface RunKhResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 用捕获输出的 CliContext 调用 cli 的 main()，驱动一次 kh 命令；不 fork 真实进程 */
export async function runKh(args: string[], opts: RunKhOptions): Promise<RunKhResult> {
  let stdout = "";
  let stderr = "";
  const ctx: CliContext = {
    cwd: opts.cwd,
    env: { ...opts.env, KH_HOME: opts.khHome },
    stdout: {
      write: (s) => {
        stdout += s;
      },
    },
    stderr: {
      write: (s) => {
        stderr += s;
      },
    },
    stdin: opts.stdin !== undefined ? Readable.from([opts.stdin]) : Readable.from([]),
    isTTY: opts.isTTY ?? false,
    now: () => new Date(),
    platform: process.platform,
    hostname: os.hostname(),
    homeDir: os.homedir(),
    fetch: globalThis.fetch.bind(globalThis),
  };
  const code = await main(args, ctx);
  return { code, stdout, stderr };
}
