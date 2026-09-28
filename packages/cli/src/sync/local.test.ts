import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectLocalPath, LocalChangedError, writeLocalFile } from "./local";

const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length > 0) await fs.rm(dirs.pop()!, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

async function inspectWritable(root: string, relPath: string) {
  const entry = await inspectLocalPath(root, relPath);
  if (entry.kind === "unsafe") throw new Error(`测试前置条件失败：${relPath} 不安全`);
  return entry;
}

describe("inspectLocalPath", () => {
  it("文件不存在（包括父目录也不存在）：absent", async () => {
    const root = await tempDir("kh-local-");
    expect(await inspectLocalPath(root, "a.md")).toEqual({ kind: "absent" });
    expect(await inspectLocalPath(root, "x/y/z.md")).toEqual({ kind: "absent" });
  });

  it("普通文件：file，带 size 与 mtime", async () => {
    const root = await tempDir("kh-local-");
    await fs.mkdir(path.join(root, "docs"));
    await fs.writeFile(path.join(root, "docs", "a.md"), "hello");
    const entry = await inspectLocalPath(root, "docs/a.md");
    expect(entry.kind).toBe("file");
    if (entry.kind === "file") {
      expect(entry.size).toBe(5);
      expect(entry.absPath).toBe(path.join(root, "docs", "a.md"));
    }
  });

  it("某一级父目录是软链接：unsafe", async () => {
    const root = await tempDir("kh-local-");
    const outside = await tempDir("kh-outside-");
    await fs.symlink(outside, path.join(root, "docs"));
    expect((await inspectLocalPath(root, "docs/a.md")).kind).toBe("unsafe");
    // 链接目标里即使有同名文件，也不能当成本地文件
    await fs.writeFile(path.join(outside, "a.md"), "x");
    expect((await inspectLocalPath(root, "docs/a.md")).kind).toBe("unsafe");
  });

  it("本身是软链接（即使指向仓库内的文件）：unsafe", async () => {
    const root = await tempDir("kh-local-");
    await fs.writeFile(path.join(root, "real.md"), "x");
    await fs.symlink(path.join(root, "real.md"), path.join(root, "link.md"));
    expect((await inspectLocalPath(root, "link.md")).kind).toBe("unsafe");
  });

  it("本地同名路径是目录：unsafe", async () => {
    const root = await tempDir("kh-local-");
    await fs.mkdir(path.join(root, "a.md"));
    expect((await inspectLocalPath(root, "a.md")).kind).toBe("unsafe");
  });

  it("某一级父路径是普通文件：unsafe", async () => {
    const root = await tempDir("kh-local-");
    await fs.writeFile(path.join(root, "docs"), "x");
    expect((await inspectLocalPath(root, "docs/a.md")).kind).toBe("unsafe");
  });
});

describe("writeLocalFile", () => {
  it("逐级建出缺少的父目录后原子写入，返回新的 size 与 mtime", async () => {
    const root = await tempDir("kh-local-");
    const result = await writeLocalFile(root, "x/y/z.md", bytes("hello"), { kind: "absent" });
    expect(await fs.readFile(path.join(root, "x", "y", "z.md"), "utf8")).toBe("hello");
    const stat = await fs.stat(path.join(root, "x", "y", "z.md"));
    expect(result.size).toBe(5);
    expect(result.mtimeMs).toBe(stat.mtimeMs);
    // 目录里不留临时文件
    expect(await fs.readdir(path.join(root, "x", "y"))).toEqual(["z.md"]);
  });

  it("仓库根本身经由软链接访问（例如 macOS 的 /var）：照常写入", async () => {
    const real = await tempDir("kh-local-");
    const holder = await tempDir("kh-local-link-");
    const linkedRoot = path.join(holder, "root");
    await fs.symlink(real, linkedRoot);
    await writeLocalFile(linkedRoot, "x/a.md", bytes("ok"), { kind: "absent" });
    expect(await fs.readFile(path.join(real, "x", "a.md"), "utf8")).toBe("ok");
  });

  it("父目录是指向仓库外的软链接：拒绝写入，仓库外没有任何文件", async () => {
    const root = await tempDir("kh-local-");
    const outside = await tempDir("kh-outside-");
    await fs.symlink(outside, path.join(root, "docs"));
    await expect(writeLocalFile(root, "docs/a.md", bytes("x"), { kind: "absent" })).rejects.toBeInstanceOf(LocalChangedError);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("检查之后路径变成了软链接（先检查后写入的间隙）：拒绝写入", async () => {
    const root = await tempDir("kh-local-");
    const outside = await tempDir("kh-outside-");
    const before = await inspectLocalPath(root, "docs/a.md");
    expect(before.kind).toBe("absent");
    await fs.symlink(outside, path.join(root, "docs"));
    await expect(writeLocalFile(root, "docs/a.md", bytes("x"), { kind: "absent" })).rejects.toBeInstanceOf(LocalChangedError);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("预期不存在但写入前文件已经出现：拒绝覆盖", async () => {
    const root = await tempDir("kh-local-");
    await fs.writeFile(path.join(root, "a.md"), "user");
    await expect(writeLocalFile(root, "a.md", bytes("x"), { kind: "absent" })).rejects.toBeInstanceOf(LocalChangedError);
    expect(await fs.readFile(path.join(root, "a.md"), "utf8")).toBe("user");
  });

  it("覆盖：文件在检查之后被改动（size 变了）时拒绝覆盖", async () => {
    const root = await tempDir("kh-local-");
    await fs.writeFile(path.join(root, "a.md"), "old");
    const entry = await inspectWritable(root, "a.md");
    expect(entry.kind).toBe("file");
    await fs.writeFile(path.join(root, "a.md"), "edited by user");
    await expect(writeLocalFile(root, "a.md", bytes("remote"), entry)).rejects.toBeInstanceOf(LocalChangedError);
    expect(await fs.readFile(path.join(root, "a.md"), "utf8")).toBe("edited by user");
  });

  it("覆盖：文件没变时写入新内容", async () => {
    const root = await tempDir("kh-local-");
    await fs.writeFile(path.join(root, "a.md"), "old");
    const entry = await inspectWritable(root, "a.md");
    await writeLocalFile(root, "a.md", bytes("new"), entry);
    expect(await fs.readFile(path.join(root, "a.md"), "utf8")).toBe("new");
  });
});
