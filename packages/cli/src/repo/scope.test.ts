import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupDir, makeTempDir } from "./test-helpers";
import { suggestSyncInclude } from "./scope";

describe("suggestSyncInclude", () => {
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

  it("什么都没有时返回空数组", async () => {
    const root = await tempDir();
    expect(await suggestSyncInclude(root)).toEqual([]);
  });

  it("只有 docs/ 目录", async () => {
    const root = await tempDir();
    await fs.mkdir(path.join(root, "docs"));
    expect(await suggestSyncInclude(root)).toEqual(["docs/**"]);
  });

  it("docs、doc、design 都存在时按固定顺序给出", async () => {
    const root = await tempDir();
    await fs.mkdir(path.join(root, "docs"));
    await fs.mkdir(path.join(root, "doc"));
    await fs.mkdir(path.join(root, "design"));
    expect(await suggestSyncInclude(root)).toEqual(["docs/**", "doc/**", "design/**"]);
  });

  it("根目录有 .md 文件（含 CLAUDE.local.md）但没有文档目录时，只建议 *.md", async () => {
    const root = await tempDir();
    await fs.writeFile(path.join(root, "README.md"), "# readme", "utf8");
    await fs.writeFile(path.join(root, "CLAUDE.local.md"), "# local", "utf8");
    expect(await suggestSyncInclude(root)).toEqual(["*.md"]);
  });

  it("文档目录和根目录 .md 文件同时存在时，两者都建议，且 *.md 排在最后", async () => {
    const root = await tempDir();
    await fs.mkdir(path.join(root, "docs"));
    await fs.writeFile(path.join(root, "README.md"), "# readme", "utf8");
    expect(await suggestSyncInclude(root)).toEqual(["docs/**", "*.md"]);
  });

  it("根目录只有非 .md 文件时不建议 *.md", async () => {
    const root = await tempDir();
    await fs.writeFile(path.join(root, "notes.txt"), "hi", "utf8");
    expect(await suggestSyncInclude(root)).toEqual([]);
  });

  it("docs 存在但是个文件而不是目录时不算数", async () => {
    const root = await tempDir();
    await fs.writeFile(path.join(root, "docs"), "not a dir", "utf8");
    expect(await suggestSyncInclude(root)).toEqual([]);
  });
});
