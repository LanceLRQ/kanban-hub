import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GitError, GitRepo } from "./git";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "kh-git-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function log(format: string): Promise<string> {
  const { stdout } = await new GitRepo(dir).run(["log", `--format=${format}`]);
  return stdout.trim();
}

async function write(name: string, content: string): Promise<void> {
  await fs.writeFile(path.join(dir, name), content);
}

describe("GitRepo", () => {
  it("init 在空目录建仓库，已经是仓库时返回 false", async () => {
    const repo = new GitRepo(dir);
    expect(await repo.init()).toBe(true);
    expect(await repo.init()).toBe(false);
  });

  it("commit 用指定的作者，提交者固定为 kanban-hub", async () => {
    const repo = new GitRepo(dir);
    await repo.init();
    await write("a.txt", "a");
    await repo.stageFiles(["a.txt"]);
    await repo.commit("第一次", { name: "Alice", email: "u1@kanban-hub.local" });
    expect(await log("%an <%ae>|%cn <%ce>|%s")).toBe(
      "Alice <u1@kanban-hub.local>|kanban-hub <kanban-hub@kanban-hub.local>|第一次",
    );
  });

  it("作者名里的尖括号和换行会被去掉", async () => {
    const repo = new GitRepo(dir);
    await repo.init();
    await write("a.txt", "a");
    await repo.stageFiles(["a.txt"]);
    await repo.commit("x", { name: "A<b>\nc", email: "u1@kanban-hub.local" });
    expect(await log("%an")).toBe("Abc");
  });

  it("作者名和邮箱清理后为空时，用默认值兜底", async () => {
    const repo = new GitRepo(dir);
    await repo.init();
    await write("a.txt", "a");
    await repo.stageFiles(["a.txt"]);
    await repo.commit("x", { name: " <> ", email: "\n" });
    expect(await log("%an <%ae>")).toBe("unknown <unknown@kanban-hub.local>");
  });

  it("命令超时被强杀后删除 index.lock、HEAD.lock 和 refs 下的锁，并抛出 GitError", async () => {
    const repo = new GitRepo(dir, "git", { timeoutMs: 200 });
    await repo.init();
    const locks = ["index.lock", "HEAD.lock", "refs/heads/main.lock"].map((l) => path.join(dir, ".git", l));
    for (const lock of locks) await fs.writeFile(lock, "");
    const start = Date.now();
    // 别名 !sleep 让 git 一直等到子进程结束，模拟卡住的 git 调用
    const err = await repo.run(["-c", "alias.hang=!sleep 3", "hang"]).catch((e: unknown) => e);
    expect(Date.now() - start).toBeLessThan(2_500);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).message).toContain("超时");
    for (const lock of locks) await expect(fs.access(lock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removeStaleLocks 删除 index.lock、HEAD.lock 和 refs 下的 .lock，不碰其他文件", async () => {
    const repo = new GitRepo(dir);
    await repo.init();
    await write("a.txt", "a");
    await repo.commitAll("初始");
    const gitDir = path.join(dir, ".git");
    await fs.mkdir(path.join(gitDir, "refs", "heads", "feature"), { recursive: true });
    const locks = ["index.lock", "HEAD.lock", "refs/heads/main.lock", "refs/heads/feature/x.lock"];
    for (const l of locks) await fs.writeFile(path.join(gitDir, l), "");
    await repo.removeStaleLocks();
    for (const l of locks) await expect(fs.access(path.join(gitDir, l))).rejects.toMatchObject({ code: "ENOENT" });
    await fs.access(path.join(gitDir, "refs", "heads", "main"));
    await write("a.txt", "b");
    expect(await repo.commitAll("锁清理之后")).toBe(true);
  });

  it("commitAll 的 forceInclude 纳入被嵌套 .gitignore 忽略的文件；路径不存在时跳过", async () => {
    const repo = new GitRepo(dir);
    await repo.init();
    await fs.mkdir(path.join(dir, "projects", "p"), { recursive: true });
    await write("projects/p/.gitignore", "*\n");
    await write("projects/p/doc.md", "d");
    expect(await repo.commitAll("强制纳入", [], ["projects", "missing"])).toBe(true);
    const { stdout } = await repo.run(["ls-files"]);
    expect(stdout.split("\n").filter(Boolean).sort()).toEqual(["projects/p/.gitignore", "projects/p/doc.md"]);
  });

  it("stageFiles 暂存新增、修改和删除，跳过从未存在的路径，不碰其他文件", async () => {
    const repo = new GitRepo(dir);
    await repo.init();
    await write("a.txt", "a");
    await write("b.txt", "b");
    await repo.commitAll("初始");
    await fs.rm(path.join(dir, "a.txt"));
    await write("b.txt", "b2");
    await write("c[1].txt", "c");
    await write("other.txt", "o");
    await repo.stageFiles(["a.txt", "b.txt", "c[1].txt", "never.txt"]);
    const { stdout } = await repo.run(["status", "--porcelain"]);
    expect(stdout.split("\n").filter(Boolean).sort()).toEqual(["?? other.txt", "A  c[1].txt", "D  a.txt", "M  b.txt"]);
  });

  it("hasStagedChanges 反映暂存区有没有改动，还没有提交的新仓库也适用", async () => {
    const repo = new GitRepo(dir);
    await repo.init();
    expect(await repo.hasStagedChanges()).toBe(false);
    await write("a.txt", "a");
    await repo.stageFiles(["a.txt"]);
    expect(await repo.hasStagedChanges()).toBe(true);
  });

  it("commitAll 提交全部改动，作者是 kanban-hub；没有改动时返回 false", async () => {
    const repo = new GitRepo(dir);
    await repo.init();
    await write("a.txt", "a");
    expect(await repo.commitAll("补提交")).toBe(true);
    expect(await log("%an|%s")).toBe("kanban-hub|补提交");
    expect(await repo.commitAll("再来一次")).toBe(false);
  });

  it("commitAll 可以排除指定路径，即使没有 .gitignore 规则", async () => {
    const repo = new GitRepo(dir);
    await repo.init();
    await fs.mkdir(path.join(dir, "secret"), { recursive: true });
    await write("secret/token", "t");
    await write("a.txt", "a");
    expect(await repo.commitAll("排除 secret", ["secret"])).toBe(true);
    const { stdout } = await repo.run(["ls-files"]);
    expect(stdout.split("\n").filter(Boolean).sort()).toEqual(["a.txt"]);
  });

  it("不受外部 GIT_* 环境变量和用户全局配置影响", async () => {
    const repo = new GitRepo(dir);
    await repo.init();
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "kh-home-"));
    await fs.writeFile(path.join(fakeHome, ".gitconfig"), "[user]\n\tname = Leak\n[commit]\n\tgpgsign = true\n");
    const saved = { HOME: process.env.HOME, GIT_DIR: process.env.GIT_DIR, GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME };
    process.env.HOME = fakeHome;
    process.env.GIT_DIR = "/nonexistent";
    process.env.GIT_AUTHOR_NAME = "Leak";
    try {
      await write("a.txt", "a");
      expect(await repo.commitAll("隔离")).toBe(true);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await fs.rm(fakeHome, { recursive: true, force: true });
    }
    expect(await log("%an|%s")).toBe("kanban-hub|隔离");
  });

  it("命令失败时抛出 GitError，带上参数和错误输出", async () => {
    const err = await new GitRepo(dir).run(["log"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).message).toContain("git log");
    expect((err as GitError).stderr).toMatch(/not a git repository/i);
  });

  it("git 不存在时抛出 GitError", async () => {
    const err = await new GitRepo(dir, "/nonexistent/git").run(["--version"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
  });
});
