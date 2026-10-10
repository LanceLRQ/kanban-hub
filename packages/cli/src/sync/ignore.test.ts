import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SyncScope } from "@kanban-hub/core/schema";
import { CliError, EXIT } from "../errors";
import { createSyncRules, readIgnoreLines } from "./ignore";

const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) await fs.rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "kh-ignore-")));
  dirs.push(dir);
  return dir;
}

function scope(overrides: Partial<SyncScope> = {}): SyncScope {
  return { include: ["docs/**"], exclude: [], maxFileSize: 5 * 1024 * 1024, ...overrides };
}

describe("readIgnoreLines", () => {
  it("文件不存在返回空数组", async () => {
    expect(await readIgnoreLines(await tempDir())).toEqual([]);
  });

  it("空文件返回空数组，只有注释时原样返回各行", async () => {
    const root = await tempDir();
    await fs.mkdir(path.join(root, ".kanban-hub"));
    await fs.writeFile(path.join(root, ".kanban-hub", "ignore"), "");
    expect(await readIgnoreLines(root)).toEqual([]);
    await fs.writeFile(path.join(root, ".kanban-hub", "ignore"), "# 只有注释\r\n\r\n");
    const lines = await readIgnoreLines(root);
    const rules = createSyncRules(scope(), lines);
    expect(rules.isSynced("docs/a.md")).toBe(true);
  });

  it("文件开头的 UTF-8 BOM 被去掉，第一行规则照常生效", async () => {
    const root = await tempDir();
    await fs.mkdir(path.join(root, ".kanban-hub"));
    await fs.writeFile(path.join(root, ".kanban-hub", "ignore"), "\uFEFFdocs/tmp/\n*.log\n");
    const lines = await readIgnoreLines(root);
    expect(lines).toEqual(["docs/tmp/", "*.log"]);
    expect(createSyncRules(scope(), lines).isSynced("docs/tmp/a.md")).toBe(false);
  });

  it("读取出错（不是不存在）时抛出，不当成空", async () => {
    const root = await tempDir();
    // ignore 是目录：读取会报 EISDIR
    await fs.mkdir(path.join(root, ".kanban-hub", "ignore"), { recursive: true });
    const err = await readIgnoreLines(root).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(EXIT.USAGE);
    expect((err as CliError).message).toContain("无法读取忽略文件");
    expect((err as CliError).message).toContain(path.join(root, ".kanban-hub", "ignore"));
  });

  it("按行返回文本", async () => {
    const root = await tempDir();
    await fs.mkdir(path.join(root, ".kanban-hub"));
    await fs.writeFile(path.join(root, ".kanban-hub", "ignore"), "docs/tmp/\n*.log\n");
    expect(await readIgnoreLines(root)).toEqual(["docs/tmp/", "*.log"]);
  });
});

describe("createSyncRules：内置规则", () => {
  const rules = createSyncRules(scope(), []);

  it.each(["docs/x/venv/lib/a.py", "docs/__pycache__/a.pyc", "docs/.DS_Store", "docs/node_modules/a.md", "docs/.next/a.md"])(
    "%s 不同步",
    (p) => {
      expect(rules.isSynced(p)).toBe(false);
    },
  );

  it.each(["docs/build/guide.md", "docs/dist/a.html", "docs/a.md"])("%s 同步", (p) => {
    expect(rules.isSynced(p)).toBe(true);
  });

  it("explain 给出原因类别与命中的规则文本", () => {
    expect(rules.explain("docs/venv/a.py")).toEqual({ synced: false, category: "builtin", rule: "venv/" });
    expect(rules.explain("docs/a.md")).toEqual({ synced: true });
  });
});

describe("createSyncRules：硬排除", () => {
  const rules = createSyncRules(scope({ include: ["**"] }), ["!.git/", "!a/.GIT/"]);

  it("任意一段是 .git（不分大小写）都不同步，忽略文件也加不回", () => {
    expect(rules.isSynced("a/.git/config")).toBe(false);
    expect(rules.isSynced("a/.GIT/config")).toBe(false);
    expect(rules.isSynced(".git/HEAD")).toBe(false);
    expect(rules.isSynced("wt/.git")).toBe(false);
    expect(rules.explain("a/.git/config")).toEqual({ synced: false, category: "hard" });
  });

  it(".gitignore 之类名字相近的文件不受影响", () => {
    expect(rules.isSynced("a/.gitignore")).toBe(true);
  });
});

describe("createSyncRules：忽略文件", () => {
  it("匹配不分大小写：docs/Drafts/ 排除 docs/drafts/a.md", () => {
    const rules = createSyncRules(scope(), ["docs/Drafts/"]);
    expect(rules.isSynced("docs/drafts/a.md")).toBe(false);
    expect(rules.isSynced("docs/DRAFTS/a.md")).toBe(false);
  });

  it("追加排除：目录规则、通配、锚定写法", () => {
    const rules = createSyncRules(scope(), ["docs/tmp/", "*.log", "/docs/a.md"]);
    expect(rules.isSynced("docs/tmp/x.md")).toBe(false);
    expect(rules.isSynced("docs/sub/x.log")).toBe(false);
    expect(rules.isSynced("docs/a.md")).toBe(false);
    expect(rules.isSynced("docs/sub/a.md")).toBe(true);
    expect(rules.explain("docs/tmp/x.md")).toEqual({ synced: false, category: "ignoreFile", rule: "docs/tmp/" });
  });

  it("! 加回内置规则排除的目录：其下文件同步，其中的 __pycache__ 仍不同步", () => {
    const rules = createSyncRules(scope(), ["!docs/x/venv/"]);
    expect(rules.isSynced("docs/x/venv/readme.md")).toBe(true);
    expect(rules.isSynced("docs/x/venv/sub/b.md")).toBe(true);
    expect(rules.isSynced("docs/x/venv/__pycache__/a.pyc")).toBe(false);
    expect(rules.isSynced("docs/y/venv/readme.md")).toBe(false);
  });

  it("优先级：sync.exclude 命中时，没有 ! 不同步，有 ! 加回就同步", () => {
    const s = scope({ exclude: ["docs/keep/**"] });
    expect(createSyncRules(s, []).isSynced("docs/keep/a.md")).toBe(false);
    const rules = createSyncRules(s, ["!docs/keep/"]);
    expect(rules.isSynced("docs/keep/a.md")).toBe(true);
    expect(rules.isSynced("docs/other/a.md")).toBe(true);
  });

  it("sync.exclude 照常生效", () => {
    const rules = createSyncRules(scope({ exclude: ["docs/draft/**"] }), []);
    expect(rules.isSynced("docs/draft/a.md")).toBe(false);
    expect(rules.explain("docs/draft/a.md")).toEqual({ synced: false, category: "exclude" });
  });

  it("include 之外的路径即使写了 ! 也不同步", () => {
    const rules = createSyncRules(scope(), ["!src/venv/"]);
    expect(rules.isSynced("src/venv/a.md")).toBe(false);
    expect(rules.explain("src/venv/a.md")).toEqual({ synced: false, category: "outOfInclude" });
  });
});

describe("createSyncRules：目录判定", () => {
  it("内置规则排除的目录给出原因与规则；其他目录不排除", () => {
    const rules = createSyncRules(scope(), ["docs/tmp/"]);
    expect(rules.dirDecision("docs/x/venv")).toEqual({ excluded: { category: "builtin", rule: "venv/" }, selfReinstated: false });
    expect(rules.dirDecision("docs/tmp")).toEqual({ excluded: { category: "ignoreFile", rule: "docs/tmp/" }, selfReinstated: false });
    expect(rules.dirDecision("docs/sub")).toEqual({ excluded: null, selfReinstated: false });
  });

  it("目录自身被 ! 加回才标记 selfReinstated，祖先目录被加回不传给子目录", () => {
    const rules = createSyncRules(scope(), ["!docs/env1/"]);
    expect(rules.dirDecision("docs/env1")).toEqual({ excluded: null, selfReinstated: true });
    expect(rules.dirDecision("docs/env1/sub")).toEqual({ excluded: null, selfReinstated: false });
    expect(createSyncRules(scope(), ["!docs/"]).dirDecision("docs/env1")).toEqual({ excluded: null, selfReinstated: false });
  });
});
