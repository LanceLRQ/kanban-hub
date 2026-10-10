import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SYNC_BUILTIN_IGNORE } from "@kanban-hub/core/sync";
import { createSyncRules, readIgnoreLines } from "../sync/ignore";
import { IGNORE_TEMPLATE, writeIgnoreTemplate } from "./ignore-template";
import { cleanupDir, makeTempDir } from "./test-helpers";

const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) await cleanupDir(dir);
  }
});

async function tempRoot(): Promise<string> {
  const dir = await makeTempDir("kh-ignore-tpl-");
  dirs.push(dir);
  return dir;
}

describe("忽略文件模板", () => {
  it("每个非空行都是注释，不会让任何文件被排除", async () => {
    for (const line of IGNORE_TEMPLATE.split("\n")) {
      if (line.trim() !== "") expect(line.startsWith("#")).toBe(true);
    }
    const root = await tempRoot();
    await writeIgnoreTemplate(root);
    const lines = await readIgnoreLines(root);
    const rules = createSyncRules({ include: ["**"], exclude: [], maxFileSize: 1024 }, lines);
    for (const p of ["docs/a.md", "README.md", "src/x.py", "docs/tmp/a.md", "a.log"]) expect(rules.isSynced(p)).toBe(true);
  });

  it("说明语法、列出内置规则、给出 ! 加回的例子和 git add -f 的用法", () => {
    for (const rule of SYNC_BUILTIN_IGNORE) expect(IGNORE_TEMPLATE).toContain(rule);
    expect(IGNORE_TEMPLATE).toContain("pyvenv.cfg");
    expect(IGNORE_TEMPLATE).toMatch(/^#.*!docs\//m);
    expect(IGNORE_TEMPLATE).toContain("git add -f .kanban-hub/ignore");
    expect(IGNORE_TEMPLATE).toContain("匹配不分大小写");
  });

  it("不存在时写出并创建 .kanban-hub/，返回 true；已存在时不动，返回 false", async () => {
    const root = await tempRoot();
    expect(await writeIgnoreTemplate(root)).toBe(true);
    const file = path.join(root, ".kanban-hub", "ignore");
    expect(await fs.readFile(file, "utf8")).toBe(IGNORE_TEMPLATE);

    await fs.writeFile(file, "docs/tmp/\n");
    expect(await writeIgnoreTemplate(root)).toBe(false);
    expect(await fs.readFile(file, "utf8")).toBe("docs/tmp/\n");
  });
});
