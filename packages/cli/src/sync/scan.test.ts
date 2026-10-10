import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SyncScope } from "@kanban-hub/core/schema";
import { createSyncScopeMatcher, matchesSyncScope, scanSyncFiles } from "./scan";

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
    expect(matchesSyncScope("docs/a.md", scope(), [])).toBe(true);
  });

  it("不在任何 include 里时为 false", () => {
    expect(matchesSyncScope("src/a.ts", scope(), [])).toBe(false);
  });

  it("命中 exclude 时即使匹配 include 也为 false", () => {
    expect(matchesSyncScope("docs/draft/a.md", scope({ include: ["docs/**"], exclude: ["docs/draft/**"] }), [])).toBe(false);
  });

  it("始终排除 node_modules，即使被 include 覆盖", () => {
    expect(matchesSyncScope("docs/node_modules/a.md", scope({ include: ["**"] }), [])).toBe(false);
  });

  it("* 不跨目录：根目录的 *.md 不匹配子目录里的文件", () => {
    const s = scope({ include: ["*.md"] });
    expect(matchesSyncScope("a.md", s, [])).toBe(true);
    expect(matchesSyncScope("docs/a.md", s, [])).toBe(false);
  });

  it("dot: true 让 include 也能匹配隐藏文件", () => {
    expect(matchesSyncScope("docs/.hidden.md", scope(), [])).toBe(true);
  });
});

describe("scanSyncFiles", () => {
  it("按 include/exclude 收集文件，结果按路径排序", async () => {
    const root = await tempDir();
    await write(root, "docs/b.md");
    await write(root, "docs/a.md");
    await write(root, "docs/draft/c.md");
    await write(root, "src/ignored.ts");

    const result = await scanSyncFiles(root, scope({ include: ["docs/**"], exclude: ["docs/draft/**"] }), []);
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
      const result = await scanSyncFiles(root, scope({ include: ["docs/**"] }), []);
      expect(result.files.map((f) => f.path)).toEqual(["docs/a.md"]);
    } finally {
      await fs.chmod(secret, 0o700); // 恢复权限，afterEach 的递归删除才能进得去
    }
  });

  it("隐藏文件被纳入", async () => {
    const root = await tempDir();
    await write(root, "docs/.hidden.md");
    const result = await scanSyncFiles(root, scope(), []);
    expect(result.files.map((f) => f.path)).toEqual(["docs/.hidden.md"]);
  });

  it("目录软链接不进入，也不记入 ignoredLinks", async () => {
    const root = await tempDir();
    await write(root, "docs/real/a.md");
    await fs.symlink(path.join(root, "docs", "real"), path.join(root, "docs", "link-dir"), "dir");

    const result = await scanSyncFiles(root, scope(), []);
    expect(result.files.map((f) => f.path)).toEqual(["docs/real/a.md"]);
    expect(result.ignoredLinks).toEqual([]);
  });

  it("仓库内的文件软链接被纳入，用链接自身的路径", async () => {
    const root = await tempDir();
    const target = await write(root, "outside-of-scope/target.md", "hello");
    await fs.mkdir(path.join(root, "docs"), { recursive: true });
    await fs.symlink(target, path.join(root, "docs", "linked.md"));

    const result = await scanSyncFiles(root, scope(), []);
    expect(result.files.map((f) => f.path)).toEqual(["docs/linked.md"]);
    expect(result.files[0]?.size).toBe(5);
  });

  it("指向仓库外的软链接进入 ignoredLinks，不计入 files", async () => {
    const root = await tempDir();
    const outside = await tempDir();
    await fs.writeFile(path.join(outside, "external.md"), "y");
    await fs.mkdir(path.join(root, "docs"), { recursive: true });
    await fs.symlink(path.join(outside, "external.md"), path.join(root, "docs", "linked.md"));

    const result = await scanSyncFiles(root, scope(), []);
    expect(result.files).toEqual([]);
    expect(result.ignoredLinks).toEqual(["docs/linked.md"]);
  });

  it("失效的软链接（目标不存在）进入 ignoredLinks", async () => {
    const root = await tempDir();
    await fs.mkdir(path.join(root, "docs"), { recursive: true });
    await fs.symlink(path.join(root, "docs", "does-not-exist.md"), path.join(root, "docs", "broken.md"));

    const result = await scanSyncFiles(root, scope(), []);
    expect(result.files).toEqual([]);
    expect(result.ignoredLinks).toEqual(["docs/broken.md"]);
  });

  it("超过大小上限的文件进入 skipped，不进入 files", async () => {
    const root = await tempDir();
    await write(root, "docs/big.md", "x".repeat(100));
    const result = await scanSyncFiles(root, scope({ maxFileSize: 10 }), []);
    expect(result.files).toEqual([]);
    expect(result.skipped).toEqual([{ path: "docs/big.md", size: 100 }]);
  });

  it("忽略本工具自己写的临时文件", async () => {
    const root = await tempDir();
    await write(root, "docs/a.md");
    await write(root, "docs/.a.md.kh-tmp-12345-1");
    const result = await scanSyncFiles(root, scope(), []);
    expect(result.files.map((f) => f.path)).toEqual(["docs/a.md"]);
  });

  it("仓库根的 .kanban-hub/ 目录不参与同步，即使 include 覆盖了它（子目录里同名的目录照常）", async () => {
    const root = await tempDir();
    await write(root, ".kanban-hub/config.yaml", "projectId: p1\n");
    await write(root, ".KANBAN-HUB/other.md");
    await write(root, "docs/a.md");
    await write(root, "docs/.kanban-hub/b.md");
    const result = await scanSyncFiles(root, scope({ include: ["**"] }), []);
    const paths = result.files.map((f) => f.path);
    expect(paths).not.toContain(".kanban-hub/config.yaml");
    expect(paths.some((p) => p.toLowerCase().startsWith(".kanban-hub/"))).toBe(false);
    expect(paths).toContain("docs/a.md");
    expect(paths).toContain("docs/.kanban-hub/b.md");

    const direct = await scanSyncFiles(root, scope({ include: [".kanban-hub/**"] }), []);
    expect(direct.files).toEqual([]);
  });

  it("include 为根目录的 *.md 时不会遍历子目录（前缀为空但只匹配根目录文件）", async () => {
    const root = await tempDir();
    await write(root, "README.md");
    await write(root, "docs/nested.md");
    const result = await scanSyncFiles(root, scope({ include: ["*.md"] }), []);
    expect(result.files.map((f) => f.path)).toEqual(["README.md"]);
  });
});

describe("scanSyncFiles：忽略规则", () => {
  const paths = (r: { files: { path: string }[] }): string[] => r.files.map((f) => f.path);

  it("内置规则：虚拟环境、缓存目录与 .DS_Store 不同步，build、dist 同步", async () => {
    const root = await tempDir();
    await write(root, "docs/x/venv/lib/a.py");
    await write(root, "docs/__pycache__/a.pyc");
    await write(root, "docs/.DS_Store");
    await write(root, "docs/build/guide.md");
    await write(root, "docs/dist/a.html");
    const result = await scanSyncFiles(root, scope(), []);
    expect(paths(result)).toEqual(["docs/build/guide.md", "docs/dist/a.html"]);
  });

  it("标记：pyvenv.cfg 所在目录整个跳过，并记入明细", async () => {
    const root = await tempDir();
    await write(root, "docs/env1/pyvenv.cfg");
    await write(root, "docs/env1/readme.md");
    await write(root, "docs/ok.md");
    const result = await scanSyncFiles(root, scope(), []);
    expect(paths(result)).toEqual(["docs/ok.md"]);
    expect(result.skippedDirs).toEqual([{ path: "docs/env1", category: "marker", reason: "Python 虚拟环境" }]);
  });

  it("标记：嵌套仓库（.git 目录）与工作树（.git 文件）所在目录整个跳过；仓库根自己的 .git 不触发", async () => {
    const root = await tempDir();
    await write(root, ".git/HEAD");
    await write(root, "docs/ref-repo/.git/HEAD");
    await write(root, "docs/ref-repo/a.md");
    await write(root, "docs/wt/.git", "gitdir: ../x");
    await write(root, "docs/wt/b.md");
    await write(root, "docs/ok.md");
    const result = await scanSyncFiles(root, scope({ include: ["**"] }), []);
    expect(paths(result)).toEqual(["docs/ok.md"]);
    expect(result.skippedDirs.map((d) => [d.path, d.category])).toEqual([
      ["docs/ref-repo", "marker"],
      ["docs/wt", "marker"],
    ]);
  });

  it("忽略文件追加排除：目录、通配与锚定写法；明细区分内置规则与忽略文件", async () => {
    const root = await tempDir();
    await write(root, "docs/tmp/x.md");
    await write(root, "docs/sub/y.log");
    await write(root, "docs/a.md");
    await write(root, "docs/sub/a.md");
    await write(root, "docs/venv/z.md");
    const result = await scanSyncFiles(root, scope(), ["docs/tmp/", "*.log", "/docs/a.md"]);
    expect(paths(result)).toEqual(["docs/sub/a.md"]);
    expect(result.skippedDirs).toEqual([
      { path: "docs/tmp", category: "ignoreFile", reason: "docs/tmp/" },
      { path: "docs/venv", category: "builtin", reason: "venv/" },
    ]);
  });

  it("! 加回：内置规则排除的目录其下文件同步，其中的 __pycache__ 仍不同步", async () => {
    const root = await tempDir();
    await write(root, "docs/x/venv/readme.md");
    await write(root, "docs/x/venv/__pycache__/a.pyc");
    const result = await scanSyncFiles(root, scope(), ["!docs/x/venv/"]);
    expect(paths(result)).toEqual(["docs/x/venv/readme.md"]);
  });

  it("! 加回标记目录后内容同步；嵌套仓库被加回后其 .git 仍不同步", async () => {
    const root = await tempDir();
    await write(root, "docs/env1/pyvenv.cfg");
    await write(root, "docs/env1/readme.md");
    await write(root, "docs/ref/.git/HEAD");
    await write(root, "docs/ref/a.md");
    const result = await scanSyncFiles(root, scope(), ["!docs/env1/", "!docs/ref/"]);
    expect(paths(result)).toEqual(["docs/env1/pyvenv.cfg", "docs/env1/readme.md", "docs/ref/a.md"]);
    expect(result.skippedDirs).toEqual([]);
  });

  it("! 加回只对标记目录自身生效：祖先目录的 ! 不放行其下的虚拟环境", async () => {
    const root = await tempDir();
    await write(root, "docs/env1/pyvenv.cfg");
    await write(root, "docs/env1/readme.md");
    await write(root, "docs/ok.md");
    const viaAncestor = await scanSyncFiles(root, scope(), ["!docs/"]);
    expect(paths(viaAncestor)).toEqual(["docs/ok.md"]);
    expect(viaAncestor.skippedDirs).toEqual([{ path: "docs/env1", category: "marker", reason: "Python 虚拟环境" }]);
    const viaSelf = await scanSyncFiles(root, scope(), ["!docs/env1/"]);
    expect(paths(viaSelf)).toEqual(["docs/env1/pyvenv.cfg", "docs/env1/readme.md", "docs/ok.md"]);
  });

  it("优先级：sync.exclude 命中的目录，忽略文件 ! 加回后同步", async () => {
    const root = await tempDir();
    await write(root, "docs/keep/a.md");
    expect(paths(await scanSyncFiles(root, scope({ exclude: ["docs/keep/**"] }), []))).toEqual([]);
    expect(paths(await scanSyncFiles(root, scope({ exclude: ["docs/keep/**"] }), ["!docs/keep/"]))).toEqual(["docs/keep/a.md"]);
  });

  it("include 之外的路径即使写了 ! 也不同步", async () => {
    const root = await tempDir();
    await write(root, "src/venv/a.md");
    await write(root, "docs/a.md");
    const result = await scanSyncFiles(root, scope(), ["!src/venv/"]);
    expect(paths(result)).toEqual(["docs/a.md"]);
  });

  it("被规则排除的目录直接剪枝，不读取它", async () => {
    const root = await tempDir();
    await write(root, "docs/venv/a.py");
    await write(root, "docs/tmp/b.md");
    await write(root, "docs/a.md");
    const spy = vi.spyOn(fs, "readdir");
    try {
      await scanSyncFiles(root, scope(), ["docs/tmp/"]);
      const read = spy.mock.calls.map((c) => String(c[0]));
      expect(read).toEqual([path.join(root, "docs")]);
    } finally {
      spy.mockRestore();
    }
  });

  it("没有被剪枝的目录时 skippedDirs 为空", async () => {
    const root = await tempDir();
    await write(root, "docs/a.md");
    expect((await scanSyncFiles(root, scope(), [])).skippedDirs).toEqual([]);
  });

  it("路径判定函数：忽略文件的行参与判定，但不做标记识别", () => {
    const s = scope();
    expect(matchesSyncScope("docs/tmp/a.md", s, ["docs/tmp/"])).toBe(false);
    expect(createSyncScopeMatcher(s, ["docs/tmp/"])("docs/ok/a.md")).toBe(true);
    expect(createSyncScopeMatcher(s, [])("docs/x/venv/a.py")).toBe(false);
    expect(createSyncScopeMatcher(s, [])("docs/env1/readme.md")).toBe(true);
  });
});
