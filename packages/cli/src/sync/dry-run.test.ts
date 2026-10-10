import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SyncScope } from "@kanban-hub/core/schema";
import { fakeContext, makeTempDir, cleanupDir } from "../repo/test-helpers";
import type { RegisteredRepo } from "../repo/root";
import { renderSyncPlan, runSyncDryRun, SUGGESTED_EXTENSIONS } from "./dry-run";
import type { ScanResult } from "./scan";

const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) await cleanupDir(dir);
  }
});

function scope(overrides: Partial<SyncScope> = {}): SyncScope {
  return { include: ["**"], exclude: [], maxFileSize: 5 * 1024 * 1024, ...overrides };
}

function file(p: string, size = 10): ScanResult["files"][number] {
  return { path: p, absPath: `/x/${p}`, size, mtimeMs: 0 };
}

function scan(overrides: Partial<ScanResult> = {}): ScanResult {
  return { files: [], skipped: [], ignoredLinks: [], skippedDirs: [], ...overrides };
}

describe("renderSyncPlan：总数与目录汇总", () => {
  it("总数与总体积，再按第一、二级目录汇总，仓库根的文件归到（根目录）", () => {
    const out = renderSyncPlan(
      scan({
        files: [
          file("README.md", 100),
          file("docs/a/b/c.md", 2048),
          file("docs/a/d.md", 1024),
          file("docs/x.md", 512),
          file("docs/z/q.png", 1024 * 1024),
        ],
      }),
      scope(),
    );
    expect(out).toContain("将同步 5 个文件，共 1.0MB");
    expect(out).toContain("（根目录）  1 个文件  100B");
    expect(out).toContain("docs/  1 个文件  512B");
    expect(out).toContain("docs/a/  2 个文件  3.0KB");
    expect(out).toContain("docs/z/  1 个文件  1.0MB");
    // 汇总按路径排序，（根目录）在最前
    const rows = out.split("\n").filter((l) => /^ {2}(（根目录）|docs\/)/.test(l));
    expect(rows.map((l) => l.trim().split("  ")[0])).toEqual(["（根目录）", "docs/", "docs/a/", "docs/z/"]);
  });

  it("没有文件时总数为 0，不输出目录汇总", () => {
    const out = renderSyncPlan(scan(), scope());
    expect(out).toContain("将同步 0 个文件，共 0B");
    expect(out).not.toContain("按目录汇总");
  });
});

describe("renderSyncPlan：被跳过的目录", () => {
  it("列出路径与原因，末尾提示用 ! 加回；没有时整节省略", () => {
    const out = renderSyncPlan(
      scan({
        skippedDirs: [
          { path: "docs/env1", category: "marker", reason: "Python 虚拟环境" },
          { path: "docs/tmp", category: "ignoreFile", reason: "docs/tmp/" },
          { path: "docs/venv", category: "builtin", reason: "venv/" },
        ],
      }),
      scope(),
    );
    expect(out).toContain("被跳过的目录：");
    expect(out).toContain("docs/env1  Python 虚拟环境");
    expect(out).toContain("docs/tmp  .kanban-hub/ignore 规则 docs/tmp/");
    expect(out).toContain("docs/venv  内置规则 venv/");
    expect(out).toContain("要上传其中某个目录，在 .kanban-hub/ignore 里写一行 `!<目录>/`");

    const none = renderSyncPlan(scan(), scope());
    expect(none).not.toContain("被跳过的目录");
    expect(none).not.toContain("!<目录>/");
  });
});

describe("renderSyncPlan：超过大小上限的文件", () => {
  it("列出文件与体积；没有时省略", () => {
    const out = renderSyncPlan(
      scan({ skipped: [{ path: "docs/big.pdf", size: 6 * 1024 * 1024 }] }),
      scope({ maxFileSize: 5 * 1024 * 1024 }),
    );
    expect(out).toContain("超过大小上限（5MB），已跳过：");
    expect(out).toContain("docs/big.pdf（6MB）");
    expect(renderSyncPlan(scan(), scope())).not.toContain("超过大小上限");
  });
});

describe("renderSyncPlan：文件类型建议", () => {
  it("建议集合外的扩展名按数量列出并给一个示例；说明建议只同步文档、网页和图片", () => {
    const out = renderSyncPlan(
      scan({
        files: [file("a.md"), file("src/a.py"), file("src/b.py"), file("Makefile"), file("x/Y.PY"), file("lib/z.so")],
      }),
      scope(),
    );
    expect(out).toContain("文件类型建议：");
    expect(out).toContain(".py  3 个，例如 src/a.py");
    expect(out).toContain(".so  1 个，例如 lib/z.so");
    expect(out).toContain("（无扩展名）  1 个，例如 Makefile");
    expect(out).toContain("建议只同步文档、网页和图片；不需要的加进 .kanban-hub/ignore");
    expect(out).not.toMatch(/^ {2}\.md /m);
  });

  it("扩展名比较不分大小写；全部在建议集合内时整节省略", () => {
    const out = renderSyncPlan(scan({ files: [file("A.MD"), file("b.Png"), file("c.yml"), file("d.drawio")] }), scope());
    expect(out).not.toContain("文件类型建议");
  });

  it("建议集合包含约定的全部扩展名", () => {
    for (const ext of [
      "md", "mdx", "txt", "pdf", "rst", "adoc", "csv",
      "html", "htm", "css", "js", "mjs", "json", "svg", "woff", "woff2", "ttf", "otf",
      "png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "bmp",
      "mmd", "puml", "drawio", "excalidraw", "yaml", "yml",
    ]) {
      expect(SUGGESTED_EXTENSIONS.has(ext)).toBe(true);
    }
  });
});

describe("runSyncDryRun", () => {
  it("扫描临时仓库并输出计划，不写入仓库", async () => {
    const root = await makeTempDir("kh-dry-run-");
    dirs.push(root);
    const write = async (rel: string, content = "x"): Promise<void> => {
      const abs = path.join(root, ...rel.split("/"));
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content);
    };
    await write("docs/a.md", "hello");
    await write("docs/env1/pyvenv.cfg");
    await write("docs/env1/readme.md");
    await write("docs/tool.py");
    await write("docs/big.pdf", "x".repeat(2048));
    await fs.mkdir(path.join(root, ".kanban-hub"));
    await fs.writeFile(path.join(root, ".kanban-hub", "ignore"), "# 空\n");

    let out = "";
    const ctx = fakeContext({ stdout: { write: (s) => void (out += String(s)) } });
    const repo: RegisteredRepo = {
      root,
      config: {
        projectId: "p000000001",
        sync: { include: ["docs/**"], exclude: [], maxFileSize: 1024 },
        pull: { auto: true },
      },
    };
    await runSyncDryRun(ctx, repo);
    expect(out).toContain("将同步 2 个文件");
    expect(out).toContain("docs/env1  Python 虚拟环境");
    expect(out).toContain("docs/big.pdf（2KB）");
    expect(out).toContain(".py  1 个，例如 docs/tool.py");
  });
});
