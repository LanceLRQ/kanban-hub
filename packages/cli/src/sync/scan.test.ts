import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SyncScope } from "@kanban-hub/core/schema";
import { matchesSyncScope, scanSyncFiles } from "./scan";

const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) {
      // 有的测试会把某个子目录权限收紧到 0，删除前统一恢复，否则递归删除可能失败
      await fs.chmod(dir, 0o700).catch(() => {});
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

async function tempDir(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "kh-scan-")));
  dirs.push(dir);
  return dir;
}

function scope(overrides: Partial<SyncScope> = {}): SyncScope {
  return { include: ["docs/**"], exclude: [], maxFileSize: 5 * 1024 * 1024, ...overrides };
}

async function write(root: string, relPath: string, content = "x"): Promise<string> {
  const abs = path.join(root, ...relPath.split("/"));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  return abs;
}

describe("matchesSyncScope", () => {
  it("命中 include 且不在 exclude 里时为 true", () => {
    expect(matchesSyncScope("docs/a.md", scope())).toBe(true);
  });

  it("不在任何 include 里时为 false", () => {
    expect(matchesSyncScope("src/a.ts", scope())).toBe(false);
  });

  it("命中 exclude 时即使匹配 include 也为 false", () => {
    expect(matchesSyncScope("docs/draft/a.md", scope({ include: ["docs/**"], exclude: ["docs/draft/**"] }))).toBe(false);
  });

  it("始终排除 node_modules，即使被 include 覆盖", () => {
    expect(matchesSyncScope("docs/node_modules/a.md", scope({ include: ["**"] }))).toBe(false);
  });

  it("* 不跨目录：根目录的 *.md 不匹配子目录里的文件", () => {
    const s = scope({ include: ["*.md"] });
    expect(matchesSyncScope("a.md", s)).toBe(true);
    expect(matchesSyncScope("docs/a.md", s)).toBe(false);
  });

  it("dot: true 让 include 也能匹配隐藏文件", () => {
    expect(matchesSyncScope("docs/.hidden.md", scope())).toBe(true);
  });
});

describe("scanSyncFiles", () => {
  it("按 include/exclude 收集文件，结果按路径排序", async () => {
    const root = await tempDir();
    await write(root, "docs/b.md");
    await write(root, "docs/a.md");
    await write(root, "docs/draft/c.md");
    await write(root, "src/ignored.ts");

    const result = await scanSyncFiles(root, scope({ include: ["docs/**"], exclude: ["docs/draft/**"] }));
    expect(result.files.map((f) => f.path)).toEqual(["docs/a.md", "docs/b.md"]);
    expect(result.files[0]?.absPath).toBe(path.join(root, "docs", "a.md"));
  });

  it("只从 include 的静态前缀开始遍历：前缀之外的不可读目录不会导致报错", async () => {
    const root = await tempDir();
    await write(root, "docs/a.md");
    const secret = path.join(root, "secret");
    await fs.mkdir(secret);
    await write(root, "secret/x.md");
    await fs.chmod(secret, 0); // 去掉所有权限：如果扫描误入这个目录，readdir 会失败
    try {
      const result = await scanSyncFiles(root, scope({ include: ["docs/**"] }));
      expect(result.files.map((f) => f.path)).toEqual(["docs/a.md"]);
    } finally {
      await fs.chmod(secret, 0o700); // 恢复权限，afterEach 的递归删除才能进得去
    }
  });

  it("隐藏文件被纳入", async () => {
    const root = await tempDir();
    await write(root, "docs/.hidden.md");
    const result = await scanSyncFiles(root, scope());
    expect(result.files.map((f) => f.path)).toEqual(["docs/.hidden.md"]);
  });

  it("目录软链接不进入，也不记入 ignoredLinks", async () => {
    const root = await tempDir();
    await write(root, "docs/real/a.md");
    await fs.symlink(path.join(root, "docs", "real"), path.join(root, "docs", "link-dir"), "dir");

    const result = await scanSyncFiles(root, scope());
    expect(result.files.map((f) => f.path)).toEqual(["docs/real/a.md"]);
    expect(result.ignoredLinks).toEqual([]);
  });

  it("仓库内的文件软链接被纳入，用链接自身的路径", async () => {
    const root = await tempDir();
    const target = await write(root, "outside-of-scope/target.md", "hello");
    await fs.mkdir(path.join(root, "docs"), { recursive: true });
    await fs.symlink(target, path.join(root, "docs", "linked.md"));

    const result = await scanSyncFiles(root, scope());
    expect(result.files.map((f) => f.path)).toEqual(["docs/linked.md"]);
    expect(result.files[0]?.size).toBe(5);
  });

  it("指向仓库外的软链接进入 ignoredLinks，不计入 files", async () => {
    const root = await tempDir();
    const outside = await tempDir();
    await fs.writeFile(path.join(outside, "external.md"), "y");
    await fs.mkdir(path.join(root, "docs"), { recursive: true });
    await fs.symlink(path.join(outside, "external.md"), path.join(root, "docs", "linked.md"));

    const result = await scanSyncFiles(root, scope());
    expect(result.files).toEqual([]);
    expect(result.ignoredLinks).toEqual(["docs/linked.md"]);
  });

  it("失效的软链接（目标不存在）进入 ignoredLinks", async () => {
    const root = await tempDir();
    await fs.mkdir(path.join(root, "docs"), { recursive: true });
    await fs.symlink(path.join(root, "docs", "does-not-exist.md"), path.join(root, "docs", "broken.md"));

    const result = await scanSyncFiles(root, scope());
    expect(result.files).toEqual([]);
    expect(result.ignoredLinks).toEqual(["docs/broken.md"]);
  });

  it("超过大小上限的文件进入 skipped，不进入 files", async () => {
    const root = await tempDir();
    await write(root, "docs/big.md", "x".repeat(100));
    const result = await scanSyncFiles(root, scope({ maxFileSize: 10 }));
    expect(result.files).toEqual([]);
    expect(result.skipped).toEqual([{ path: "docs/big.md", size: 100 }]);
  });

  it("忽略本工具自己写的临时文件", async () => {
    const root = await tempDir();
    await write(root, "docs/a.md");
    await write(root, "docs/.a.md.kh-tmp-12345-1");
    const result = await scanSyncFiles(root, scope());
    expect(result.files.map((f) => f.path)).toEqual(["docs/a.md"]);
  });

  it("仓库根的 .kanban-hub/ 目录不参与同步，即使 include 覆盖了它（子目录里同名的目录照常）", async () => {
    const root = await tempDir();
    await write(root, ".kanban-hub/config.yaml", "projectId: p1\n");
    await write(root, ".KANBAN-HUB/other.md");
    await write(root, "docs/a.md");
    await write(root, "docs/.kanban-hub/b.md");
    const result = await scanSyncFiles(root, scope({ include: ["**"] }));
    const paths = result.files.map((f) => f.path);
    expect(paths).not.toContain(".kanban-hub/config.yaml");
    expect(paths.some((p) => p.toLowerCase().startsWith(".kanban-hub/"))).toBe(false);
    expect(paths).toContain("docs/a.md");
    expect(paths).toContain("docs/.kanban-hub/b.md");

    const direct = await scanSyncFiles(root, scope({ include: [".kanban-hub/**"] }));
    expect(direct.files).toEqual([]);
  });

  it("include 为根目录的 *.md 时不会遍历子目录（前缀为空但只匹配根目录文件）", async () => {
    const root = await tempDir();
    await write(root, "README.md");
    await write(root, "docs/nested.md");
    const result = await scanSyncFiles(root, scope({ include: ["*.md"] }));
    expect(result.files.map((f) => f.path)).toEqual(["README.md"]);
  });
});
