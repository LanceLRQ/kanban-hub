import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT } from "../errors";
import { writeRepoConfig, type RepoConfig } from "./config";
import { cleanupDir, fakeContext, gitFixture, makeTempDir } from "./test-helpers";
import { findRegisteredRepo, inspectRepo, toRepoPath } from "./root";

function sampleConfig(projectId: string): RepoConfig {
  return {
    projectId,
    sync: { include: ["docs/**"], exclude: [], maxFileSize: 1024 },
    pull: { auto: true },
  };
}

describe("inspectRepo", () => {
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

  it("不是 git 仓库：root 就是当前目录，其余字段为空", async () => {
    const dir = await tempDir();
    const result = await inspectRepo(dir);
    expect(result).toEqual({ root: dir, isGit: false, gitDir: null, commonDir: null, isLinkedWorktree: false });
  });

  it("在仓库的子目录里：root 是仓库顶层，gitDir 和 commonDir 相同", async () => {
    const dir = await tempDir();
    gitFixture(["init", "-q"], dir);
    gitFixture(["commit", "-q", "--allow-empty", "-m", "init"], dir);
    const sub = path.join(dir, "a", "b");
    await fs.mkdir(sub, { recursive: true });

    const result = await inspectRepo(sub);
    expect(result.root).toBe(dir);
    expect(result.isGit).toBe(true);
    expect(result.gitDir).toBe(path.join(dir, ".git"));
    expect(result.commonDir).toBe(path.join(dir, ".git"));
    expect(result.isLinkedWorktree).toBe(false);
  });

  it("链接工作树：gitDir 指向 worktrees 下的子目录，commonDir 指向主仓库的 .git", async () => {
    const mainDir = await tempDir();
    gitFixture(["init", "-q"], mainDir);
    gitFixture(["commit", "-q", "--allow-empty", "-m", "init"], mainDir);

    const worktreeParent = await tempDir();
    const linkedDir = path.join(worktreeParent, "linked");
    gitFixture(["worktree", "add", linkedDir, "-b", "linked-branch", "-q"], mainDir);

    const result = await inspectRepo(linkedDir);
    expect(result.root).toBe(linkedDir);
    expect(result.isGit).toBe(true);
    expect(result.commonDir).toBe(path.join(mainDir, ".git"));
    expect(result.gitDir).toBe(path.join(mainDir, ".git", "worktrees", "linked"));
    expect(result.isLinkedWorktree).toBe(true);
  });
});

describe("findRegisteredRepo", () => {
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

  it("从子目录能找到仓库根的配置", async () => {
    const root = await tempDir();
    gitFixture(["init", "-q"], root);
    gitFixture(["commit", "-q", "--allow-empty", "-m", "init"], root);
    const config = sampleConfig("p000000001");
    await writeRepoConfig(root, config);

    const sub = path.join(root, "a", "b");
    await fs.mkdir(sub, { recursive: true });

    const found = await findRegisteredRepo(sub, fakeContext());
    expect(found).toEqual({ root, config });
  });

  it("从主仓库之外的链接工作树，找到主工作树根目录下的配置", async () => {
    const mainRoot = await tempDir();
    gitFixture(["init", "-q"], mainRoot);
    gitFixture(["commit", "-q", "--allow-empty", "-m", "init"], mainRoot);
    const config = sampleConfig("p000000002");
    await writeRepoConfig(mainRoot, config);

    const worktreeParent = await tempDir();
    const linkedDir = path.join(worktreeParent, "linked");
    gitFixture(["worktree", "add", linkedDir, "-b", "linked-branch-2", "-q"], mainRoot);

    const found = await findRegisteredRepo(linkedDir, fakeContext());
    expect(found).toEqual({ root: mainRoot, config });
  });

  it("嵌套的独立仓库里找不到外层仓库的配置", async () => {
    const outerRoot = await tempDir();
    gitFixture(["init", "-q"], outerRoot);
    gitFixture(["commit", "-q", "--allow-empty", "-m", "init"], outerRoot);
    await writeRepoConfig(outerRoot, sampleConfig("p000000003"));

    const innerRoot = path.join(outerRoot, "vendor", "inner");
    await fs.mkdir(innerRoot, { recursive: true });
    gitFixture(["init", "-q"], innerRoot);
    gitFixture(["commit", "-q", "--allow-empty", "-m", "init"], innerRoot);

    const found = await findRegisteredRepo(innerRoot, fakeContext());
    expect(found).toBeNull();
  });

  it("不是 git 仓库时逐级往上找，直到找到祖先目录里的配置", async () => {
    const home = await tempDir();
    const projectRoot = path.join(home, "workspace", "project");
    const cwd = path.join(projectRoot, "sub", "sub2");
    await fs.mkdir(cwd, { recursive: true });
    const config = sampleConfig("p000000004");
    await writeRepoConfig(projectRoot, config);

    const ctx = fakeContext({ homeDir: home });
    const found = await findRegisteredRepo(cwd, ctx);
    expect(found).toEqual({ root: projectRoot, config });
  });

  it("不是 git 仓库时，搜索到用户主目录为止，不会越过它", async () => {
    const base = await tempDir();
    // 配置放在 home 的上一级，home 本身和它的子目录都没有配置
    await writeRepoConfig(base, sampleConfig("p000000005"));
    const home = path.join(base, "home");
    const cwd = path.join(home, "sub");
    await fs.mkdir(cwd, { recursive: true });

    const ctx = fakeContext({ homeDir: home });
    const found = await findRegisteredRepo(cwd, ctx);
    expect(found).toBeNull();
  });
});

describe("toRepoPath", () => {
  it("仓库内的相对路径原样换算", () => {
    const root = "/repo";
    expect(toRepoPath(root, root, "docs/a.md")).toBe("docs/a.md");
  });

  it("绝对路径换算成仓库内相对路径", () => {
    const root = "/repo";
    expect(toRepoPath(root, root, "/repo/docs/a.md")).toBe("docs/a.md");
  });

  it("带 .. 但解析后仍在仓库内", () => {
    const root = "/repo";
    const cwd = "/repo/sub";
    expect(toRepoPath(root, cwd, "../docs/a.md")).toBe("docs/a.md");
  });

  it("落在仓库外时抛用法错误", () => {
    const root = "/repo";
    expect(() => toRepoPath(root, root, "../outside.md")).toThrowError(
      expect.objectContaining({ name: "CliError", exitCode: EXIT.USAGE }),
    );
  });
});
