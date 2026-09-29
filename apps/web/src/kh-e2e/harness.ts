/**
 * kh 端到端测试的公共夹具：驱动 cli 的 main()（不 spawn 真实进程，除非测试明确需要验证
 * 真实进程的退出码），以及造临时仓库、临时 KH_HOME、登录、注册项目。
 *
 * 临时目录一律先 fs.realpath 再交给调用方：macOS 的 os.tmpdir() 落在 /var，实际是
 * /private/var 的软链接，而 git 输出的是解析后的物理路径，混用会让仓库内路径的换算出错。
 */
import { execFileSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll } from "vitest";
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
export function gitFixture(args: string[], cwd: string): string {
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

/** 把 source 仓库 git clone 到一个新的临时目录：模拟同一个仓库在另一台机器上的工作区 */
export async function cloneTempRepo(source: string): Promise<TempRepo> {
  const dir = await makeRealTempDir("kh-e2e-clone-");
  gitFixture(["clone", "-q", source, dir], dir);
  const head = gitFixture(["rev-parse", "HEAD"], dir).trim();
  return { dir, commitHashes: [head], cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
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

/** 一次 spawnBackground 调用的参数记录，供测试断言 */
export interface SpawnBackgroundCall {
  args: string[];
  cwd: string;
  logFile: string;
}

export interface RunKhOptions {
  cwd: string;
  khHome: string;
  /** 额外的环境变量；KH_HOME 由 khHome 决定，这里传了也会被覆盖 */
  env?: Record<string, string | undefined>;
  /** 交互式确认要读的输入；省略时 stdin 视为立即 EOF（空输入） */
  stdin?: string;
  isTTY?: boolean;
  /**
   * ctx.homeDir；默认是一个临时目录（不再是真实主目录），这样测试忘了传它、
   * 不小心执行到 kh setup 这类直接写主目录的命令时，也不会碰到真实的 ~/.agents、~/.claude。
   * 用来测试“默认 KH_HOME 与仓库配置撞路径”这类场景时，显式传一个自定义值。
   */
  homeDir?: string;
  /** ctx.fetch，默认取全局 fetch；用来在个别测试里包一层拦截请求（例如模拟暂存被提前清理） */
  fetch?: typeof fetch;
  /** ctx.now，默认取真实的当前时间；hook 相关的测试用它注入固定或递进的时间 */
  now?: () => Date;
  /** ctx.spawnBackground；省略时用一个只记录调用参数的默认实现，通过返回值的 spawnCalls 读出 */
  spawnBackground?: (args: string[], opts: { cwd: string; logFile: string }) => void;
}

export interface RunKhResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 本模块创建过的默认 homeDir，测试文件结束时统一删除 */
const defaultHomeDirs: string[] = [];

/** 造一个临时目录当默认 homeDir 用：同步创建并解析成真实路径，登记后由 afterAll 清理 */
function makeDefaultHomeDirSync(): string {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "kh-e2e-default-home-"));
  const real = fsSync.realpathSync(dir);
  defaultHomeDirs.push(real);
  return real;
}

/** 删除已登记的默认 homeDir；harness 只被测试文件导入，afterAll 会在每个测试文件结束时调用它 */
export async function cleanupDefaultHomeDirs(): Promise<void> {
  const dirs = defaultHomeDirs.splice(0);
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
}

afterAll(cleanupDefaultHomeDirs);

/** 按 runKh 的同一套规则构造 CliContext，输出写进返回的缓冲区；直接调用 kh 内部函数的测试用它 */
export function makeKhContext(
  opts: RunKhOptions,
): { ctx: CliContext; output(): { stdout: string; stderr: string }; spawnCalls: SpawnBackgroundCall[] } {
  let stdout = "";
  let stderr = "";
  const spawnCalls: SpawnBackgroundCall[] = [];
  const ctx: CliContext = {
    cwd: opts.cwd,
    // 带上真实的 process.env（主要是 PATH）：runGit 现在只用 ctx.env，不会退回 process.env，
    // 缺了 PATH 会导致 register 等经由 git 探查仓库的命令找不到 git 可执行文件
    env: { ...process.env, ...opts.env, KH_HOME: opts.khHome },
    stdout: {
      write: (s) => {
        stdout += typeof s === "string" ? s : Buffer.from(s).toString("utf8");
      },
    },
    stderr: {
      write: (s) => {
        stderr += typeof s === "string" ? s : Buffer.from(s).toString("utf8");
      },
    },
    stdin: opts.stdin !== undefined ? Readable.from([opts.stdin]) : Readable.from([]),
    isTTY: opts.isTTY ?? false,
    now: opts.now ?? (() => new Date()),
    platform: process.platform,
    hostname: os.hostname(),
    homeDir: opts.homeDir ?? makeDefaultHomeDirSync(),
    fetch: opts.fetch ?? globalThis.fetch.bind(globalThis),
    spawnBackground:
      opts.spawnBackground ??
      ((args, spawnOpts) => {
        spawnCalls.push({ args, cwd: spawnOpts.cwd, logFile: spawnOpts.logFile });
      }),
  };
  return { ctx, output: () => ({ stdout, stderr }), spawnCalls };
}

/** 用捕获输出的 CliContext 调用 cli 的 main()，驱动一次 kh 命令；不 fork 真实进程 */
export async function runKh(args: string[], opts: RunKhOptions): Promise<RunKhResult> {
  const { ctx, output } = makeKhContext(opts);
  const code = await main(args, ctx);
  return { code, ...output() };
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

/**
 * 让另一台已登录的机器加入一个已有项目（不新建项目）：登记本机位置、写出仓库配置。
 * 调用前必须先对这个 KH_HOME 调用 loginFixture()。
 */
export async function joinProjectFixture(
  server: TestServer,
  repo: Pick<TempRepo, "dir">,
  khHome: Pick<TempDir, "dir">,
  projectId: string,
  sync: { include: string[]; exclude?: string[] },
): Promise<string> {
  const cfg = await readMachineConfig(khHome.dir);
  const machineId = cfg?.machineId;
  if (!machineId) throw new Error("测试前置条件失败：还没有登录，请先调用 loginFixture");
  const admin = server.api.store.auth.listUsers().find((u) => u.role === "admin");
  if (!admin) throw new Error("测试前置条件失败：找不到管理员账号");
  const actor: Actor = { userId: admin.id, machineId: null, via: "web", agent: null };
  await server.api.store.setLocation(projectId, machineId, { path: repo.dir }, actor);
  await writeRepoConfig(repo.dir, {
    projectId,
    sync: { include: sync.include, exclude: sync.exclude ?? [], maxFileSize: SYNC_DEFAULT_MAX_FILE_SIZE },
    pull: { auto: true },
  });
  return machineId;
}
