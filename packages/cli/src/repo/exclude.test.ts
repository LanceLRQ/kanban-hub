import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeRepoConfig } from "./config";
import { ensureExcluded, planExclude } from "./exclude";
import { inspectRepo } from "./root";
import { cleanupDir, gitFixture, makeTempDir } from "./test-helpers";

describe("planExclude / ensureExcluded", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir !== undefined) await cleanupDir(dir);
    }
  });

  async function tempRepo(): Promise<string> {
    const dir = await makeTempDir();
    dirs.push(dir);
    gitFixture(["init", "-q"], dir);
    gitFixture(["commit", "-q", "--allow-empty", "-m", "init"], dir);
    return dir;
  }

  function excludeFile(root: string): string {
    return path.join(root, ".git", "info", "exclude");
  }

  it("不是 git 仓库时跳过，不需要写", async () => {
    const dir = await makeTempDir();
    dirs.push(dir);
    const inspection = await inspectRepo(dir);

    expect((await planExclude(inspection)).needed).toBe(false);
    const result = await ensureExcluded(inspection);
    expect(result.changed).toBe(false);
  });

  it("追加一行，并保留原有内容和结尾换行", async () => {
    const root = await tempRepo();
    const before = await fs.readFile(excludeFile(root), "utf8");
    expect(before.endsWith("\n")).toBe(true); // git init 自带的默认内容以换行结尾

    const inspection = await inspectRepo(root);
    const plan = await planExclude(inspection);
    expect(plan.needed).toBe(true);
    expect(plan.path).toBe(excludeFile(root));

    const result = await ensureExcluded(inspection);
    expect(result.changed).toBe(true);
    expect(result.path).toBe(excludeFile(root));

    const after = await fs.readFile(excludeFile(root), "utf8");
    expect(after).toBe(`${before}/.kanban-hub/\n`);
  });

  it("原文件没有结尾换行时，先补换行再追加", async () => {
    const root = await tempRepo();
    await fs.mkdir(path.join(root, ".git", "info"), { recursive: true });
    await fs.writeFile(excludeFile(root), "custom-rule", "utf8");

    const inspection = await inspectRepo(root);
    await ensureExcluded(inspection);

    const after = await fs.readFile(excludeFile(root), "utf8");
    expect(after).toBe("custom-rule\n/.kanban-hub/\n");
  });

  it.each([".kanban-hub", ".kanban-hub/", "/.kanban-hub", "/.kanban-hub/"])(
    "已经有等价写法 %s 时不重复写",
    async (line) => {
      const root = await tempRepo();
      await fs.mkdir(path.join(root, ".git", "info"), { recursive: true });
      const original = `${line}\n`;
      await fs.writeFile(excludeFile(root), original, "utf8");

      const inspection = await inspectRepo(root);
      expect((await planExclude(inspection)).needed).toBe(false);

      const result = await ensureExcluded(inspection);
      expect(result.changed).toBe(false);

      const after = await fs.readFile(excludeFile(root), "utf8");
      expect(after).toBe(original);
    },
  );

  it("info/ 目录不存在时自动创建", async () => {
    const root = await tempRepo();
    await fs.rm(path.join(root, ".git", "info"), { recursive: true, force: true });

    const inspection = await inspectRepo(root);
    const result = await ensureExcluded(inspection);
    expect(result.changed).toBe(true);

    const after = await fs.readFile(excludeFile(root), "utf8");
    expect(after).toBe("/.kanban-hub/\n");
  });

  it("链接工作树写到主仓库的 info/exclude", async () => {
    const mainRoot = await tempRepo();
    const worktreeParent = await makeTempDir();
    dirs.push(worktreeParent);
    const linkedDir = path.join(worktreeParent, "linked");
    gitFixture(["worktree", "add", linkedDir, "-b", "linked-branch", "-q"], mainRoot);

    const inspection = await inspectRepo(linkedDir);
    expect(inspection.isLinkedWorktree).toBe(true);

    const result = await ensureExcluded(inspection);
    expect(result.path).toBe(excludeFile(mainRoot));
    expect(result.changed).toBe(true);

    const after = await fs.readFile(excludeFile(mainRoot), "utf8");
    expect(after).toContain("/.kanban-hub/\n");

    // 链接工作树自己的 gitdir 下不应该有 info/exclude
    await expect(fs.access(path.join(inspection.gitDir ?? "", "info", "exclude"))).rejects.toThrow();
  });

  it("写入之后，仓库的 git status --porcelain 为空，看不到 .kanban-hub/", async () => {
    const root = await tempRepo();
    const inspection = await inspectRepo(root);
    await ensureExcluded(inspection);
    await writeRepoConfig(root, {
      projectId: "p000000009",
      sync: { include: ["docs/**"], exclude: [], maxFileSize: 1024 },
      pull: { auto: true },
    });

    const status = gitFixture(["status", "--porcelain"], root);
    expect(status).toBe("");
  });
});
