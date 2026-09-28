import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KH_TMP_PATTERN, isNoEntError, writeFileAtomic } from "./fs-utils";

const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) await fs.rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kh-fs-utils-"));
  dirs.push(dir);
  return dir;
}

describe("writeFileAtomic", () => {
  it("写入字符串内容", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "a.txt");
    await writeFileAtomic(file, "hello");
    expect(await fs.readFile(file, "utf8")).toBe("hello");
  });

  it("写入字节内容", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "a.bin");
    const bytes = new Uint8Array([0, 1, 2, 255]);
    await writeFileAtomic(file, bytes);
    const read = await fs.readFile(file);
    expect(new Uint8Array(read)).toEqual(bytes);
  });

  it("mkdir: true 时创建父目录", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "a", "b", "c.txt");
    await writeFileAtomic(file, "x", { mkdir: true });
    expect(await fs.readFile(file, "utf8")).toBe("x");
  });

  it("父目录不存在且没有传 mkdir 时写入失败", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "missing", "c.txt");
    await expect(writeFileAtomic(file, "x")).rejects.toThrow();
  });

  it("写失败时不留临时文件", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "target");
    // 让目标路径本身是一个目录：rename(tmp, file) 会失败（EISDIR），但临时文件写入本身会成功，
    // 用来验证失败路径下临时文件确实被清理掉
    await fs.mkdir(file);

    await expect(writeFileAtomic(file, "x")).rejects.toThrow();

    const entries = await fs.readdir(dir);
    expect(entries).toEqual(["target"]);
  });

  it("按约定命名临时文件：目标目录下、点号开头、包含 kh-tmp", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "a.txt");
    // 写入过程中不方便直接窥视临时文件名，这里改用同一份规则手工构造，验证格式没有变化，
    // 再验证 KH_TMP_PATTERN 真的能识别出它（供扫描据此忽略）
    const guessed = `.a.txt.kh-tmp-${process.pid}-1`;
    expect(KH_TMP_PATTERN.test(guessed)).toBe(true);
    expect(KH_TMP_PATTERN.test("a.txt")).toBe(false);

    await writeFileAtomic(file, "x");
    const entries = await fs.readdir(dir);
    expect(entries).toEqual(["a.txt"]);
  });
});

describe("isNoEntError", () => {
  it("ENOENT 返回 true", async () => {
    try {
      await fs.readFile("/definitely/not/exists/kh-fs-utils-test");
    } catch (err) {
      expect(isNoEntError(err)).toBe(true);
      return;
    }
    throw new Error("期望抛出 ENOENT");
  });

  it("其他值返回 false", () => {
    expect(isNoEntError(new Error("x"))).toBe(false);
    expect(isNoEntError(null)).toBe(false);
    expect(isNoEntError("x")).toBe(false);
  });
});

describe("原子写只有一处定义", () => {
  it("repo/fs-utils.ts、config/home.ts、report-log.ts 里的旧实现都已删除", async () => {
    const roots = [
      path.join(import.meta.dirname, "repo", "fs-utils.ts"),
      path.join(import.meta.dirname, "config", "home.ts"),
      path.join(import.meta.dirname, "report-log.ts"),
    ];
    for (const file of roots) {
      let content: string | null;
      try {
        content = await fs.readFile(file, "utf8");
      } catch (err) {
        if (isNoEntError(err)) {
          content = null; // repo/fs-utils.ts 应该被整个删除
        } else {
          throw err;
        }
      }
      if (content !== null) {
        expect(content).not.toContain("function writeFileAtomic");
        expect(content).not.toContain("function isNoEntError");
      }
    }
  });
});
