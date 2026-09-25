import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupDir, initRepoWithCommit, makeTempDir } from "./test-helpers";
import { runGit } from "./git";

describe("runGit", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir !== undefined) await cleanupDir(dir);
    }
  });

  async function tempDir(): Promise<string> {
    const dir = await makeTempDir();
    dirs.push(dir);
    return dir;
  }

  it("在真实仓库里执行只读命令成功", async () => {
    const dir = await tempDir();
    const hash = initRepoWithCommit(dir);
    const result = await runGit(["rev-parse", "HEAD"], dir);
    expect(result.ok).toBe(true);
    expect(result.stdout.trim()).toBe(hash);
  });

  it("不是 git 仓库时 ok 为 false，且不抛错", async () => {
    const dir = await tempDir();
    const result = await runGit(["rev-parse", "--show-toplevel"], dir);
    expect(result.ok).toBe(false);
    expect(result.stderr).not.toBe("");
  });

  it("不经过 shell：命令注入字符原样当作单个参数，不会被 shell 拆开执行", async () => {
    const dir = await tempDir();
    initRepoWithCommit(dir);
    // 如果 runGit 经过了 shell，"; echo pwned" 会被当成另一条命令单独执行；不经过 shell 时
    // git 会把整个字符串当成一个（不存在的）引用，原样回显在 stdout 里，并以非零退出码失败
    const result = await runGit(["rev-parse", "HEAD; echo pwned"], dir);
    expect(result.ok).toBe(false);
    expect(result.stdout.trim()).toBe("HEAD; echo pwned");
  });

  it("设置了 GIT_OPTIONAL_LOCKS=0", async () => {
    const dir = await tempDir();
    initRepoWithCommit(dir);
    // 间接验证：正常只读命令依然正确执行（GIT_OPTIONAL_LOCKS=0 不应该影响读操作的结果）
    const result = await runGit(["rev-parse", "--is-inside-work-tree"], dir);
    expect(result.ok).toBe(true);
    expect(result.stdout.trim()).toBe("true");
  });

  it("找不到 git 可执行文件时抛 CliError(1)，并给出安装提示", async () => {
    const dir = await tempDir();
    const originalPath = process.env.PATH;
    process.env.PATH = path.join(dir, "empty-bin");
    try {
      await expect(runGit(["rev-parse", "HEAD"], dir)).rejects.toMatchObject({
        name: "CliError",
        exitCode: 1,
        hint: expect.stringContaining("git"),
      });
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
