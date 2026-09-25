/**
 * repo/* 测试专用的夹具：不是测试文件本身（不会被 vitest 收集），只被各 *.test.ts 引入。
 * 造仓库直接调用真实 git（不经过 runGit，runGit 只允许执行只读命令），并且：
 * - 不受开发机全局 / 系统 git 配置影响：GIT_CONFIG_GLOBAL 指到 /dev/null、GIT_CONFIG_NOSYSTEM=1；
 * - 不弹交互式签名：显式传 user.name / user.email / commit.gpgsign=false。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CliContext } from "../context";

const GIT_TEST_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

const IDENTITY_ARGS = ["-c", "user.name=kh-test", "-c", "user.email=kh-test@example.com", "-c", "commit.gpgsign=false"];

/** 在给定目录下执行 git（带固定身份、不弹签名）；测试夹具专用，生产代码一律走 runGit */
export function gitFixture(args: string[], cwd: string): string {
  return execFileSync("git", [...IDENTITY_ARGS, ...args], { cwd, env: GIT_TEST_ENV, encoding: "utf8", stdio: "pipe" });
}

/** 建一个临时目录，并解析成真实路径（macOS 的 /var 是 /private/var 的软链接，git 输出的是解析后的路径） */
export async function makeTempDir(prefix = "kh-repo-test-"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return fs.realpath(dir);
}

/** 递归删除测试用的临时目录；测试结束时调用，出错不影响测试结果 */
export async function cleanupDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

/** git init 一个仓库并提交一个空提交，返回提交 hash */
export function initRepoWithCommit(dir: string): string {
  gitFixture(["init", "-q"], dir);
  gitFixture(["commit", "--allow-empty", "-q", "-m", "init"], dir);
  return gitFixture(["rev-parse", "HEAD"], dir).trim();
}

/** 构造一个最小可用的 CliContext，供 findRegisteredRepo 等需要 ctx 的函数使用 */
export function fakeContext(overrides: Partial<CliContext> = {}): CliContext {
  return {
    cwd: "/tmp",
    env: {},
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    stdin: process.stdin,
    isTTY: false,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    platform: "linux",
    hostname: "test-host",
    homeDir: "/home/test-user",
    fetch: (() => {
      throw new Error("不应该在 repo 测试里调用 fetch");
    }) as unknown as typeof fetch,
    ...overrides,
  };
}
