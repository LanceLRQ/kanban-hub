/**
 * kh 端到端测试的公共夹具：驱动 cli 的 main()（不 spawn 真实进程，除非测试明确需要验证
 * 真实进程的退出码），以及造临时仓库、临时 KH_HOME、登录、注册项目。
 *
 * 临时目录一律先 fs.realpath 再交给调用方：macOS 的 os.tmpdir() 落在 /var，实际是
 * /private/var 的软链接，而 git 输出的是解析后的物理路径，混用会让仓库内路径的换算出错。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { Actor } from "@kanban-hub/core/schema";
import { SYNC_DEFAULT_MAX_FILE_SIZE } from "@kanban-hub/core/sync";
import { readMachineConfig } from "../../../../packages/cli/src/config/home";
import type { CliContext } from "../../../../packages/cli/src/context";
import { main } from "../../../../packages/cli/src/main";
import { writeRepoConfig } from "../../../../packages/cli/src/repo/config";
import type { TestServer } from "../server/api/test-server";

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
  /** ctx.homeDir，默认取真实的 os.homedir()；用来测试“默认 KH_HOME 与仓库配置撞路径”这类场景 */
  homeDir?: string;
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
    homeDir: opts.homeDir ?? os.homedir(),
    fetch: globalThis.fetch.bind(globalThis),
  };
  const code = await main(args, ctx);
  return { code, stdout, stderr };
}

export interface LoginFixtureOptions {
  /** 本机名称，默认“测试机” */
  name?: string;
}

/** 走真实的 /pair 路由登录，返回本机的 machineId；board / status / task 的端到端测试共用 */
export async function loginFixture(
  server: TestServer,
  repo: Pick<TempRepo, "dir">,
  khHome: Pick<TempDir, "dir">,
  opts: LoginFixtureOptions = {},
): Promise<string> {
  const { code } = server.issuePairingCode();
  const result = await runKh(["login", "--server", server.url, "--code", code, "--name", opts.name ?? "测试机"], {
    cwd: repo.dir,
    khHome: khHome.dir,
  });
  if (result.code !== 0) throw new Error(`测试前置条件失败：登录失败（${result.code}）：${result.stderr}`);
  const cfg = await readMachineConfig(khHome.dir);
  if (!cfg?.machineId) throw new Error("测试前置条件失败：登录后读不到 machineId");
  return cfg.machineId;
}

export interface RegisterFixtureOptions {
  name?: string;
  focus?: string;
}

export interface RegisterFixtureResult {
  projectId: string;
  machineId: string;
}

/**
 * 建一个项目、登记本机在这个仓库的位置、写出仓库配置：相当于 kh register 会做的事，
 * 但直接用测试服务端的 Store 完成，不经过 kh register 命令本身——register 命令自己的行为
 * 在 register.test.ts 里单独测试，这里只需要一个能让 requireRegisteredRepo 认得的前置条件。
 * 调用前必须先 loginFixture()。
 */
export async function registerProjectFixture(
  server: TestServer,
  repo: Pick<TempRepo, "dir">,
  khHome: Pick<TempDir, "dir">,
  opts: RegisterFixtureOptions = {},
): Promise<RegisterFixtureResult> {
  const cfg = await readMachineConfig(khHome.dir);
  const machineId = cfg?.machineId;
  if (!machineId) throw new Error("测试前置条件失败：还没有登录，请先调用 loginFixture");

  const admin = server.api.store.auth.listUsers().find((u) => u.role === "admin");
  if (!admin) throw new Error("测试前置条件失败：找不到管理员账号");
  const actor: Actor = { userId: admin.id, machineId: null, via: "web", agent: null };

  const { project } = await server.api.store.createProject({ name: opts.name ?? "示例项目", focus: opts.focus }, actor);
  await server.api.store.setLocation(project.id, machineId, { path: repo.dir }, actor);
  await writeRepoConfig(repo.dir, {
    projectId: project.id,
    sync: { include: [], exclude: [], maxFileSize: SYNC_DEFAULT_MAX_FILE_SIZE },
    pull: { auto: true },
  });

  return { projectId: project.id, machineId };
}
