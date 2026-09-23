import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkGitAvailable, checkWritableDir, runSelfCheck } from "./selfcheck";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kh-selfcheck-"));
});

afterEach(async () => {
  await fs.chmod(tmp, 0o700).catch(() => {});
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("checkWritableDir", () => {
  it("可写目录返回 null，且不留下探测文件", async () => {
    expect(await checkWritableDir(tmp, { create: false })).toBeNull();
    expect(await fs.readdir(tmp)).toEqual([]);
  });

  it("目录不存在且不允许创建时，报错并给出 chown 提示", async () => {
    const msg = await checkWritableDir(path.join(tmp, "missing"), { create: false });
    expect(msg).toContain("不存在");
    expect(msg).toContain("chown");
  });

  it("目录不存在但允许创建时，自动创建并返回 null", async () => {
    const dir = path.join(tmp, "a", "b");
    expect(await checkWritableDir(dir, { create: true })).toBeNull();
    expect((await fs.stat(dir)).isDirectory()).toBe(true);
  });

  it("路径是文件而不是目录时报错", async () => {
    const file = path.join(tmp, "f");
    await fs.writeFile(file, "");
    expect(await checkWritableDir(file, { create: false })).toContain("不是目录");
  });

  // root 对只读目录也能写入，这个用例在 root 身份下没有意义
  it.skipIf(process.getuid?.() === 0)("目录不可写时报错并给出 chown 提示", async () => {
    await fs.chmod(tmp, 0o500);
    const msg = await checkWritableDir(tmp, { create: false });
    expect(msg).toContain("不可写");
    expect(msg).toContain("chown");
  });
});

describe("checkGitAvailable", () => {
  it("系统有 git 时返回 null", async () => {
    expect(await checkGitAvailable()).toBeNull();
  });

  it("命令不存在时报错", async () => {
    expect(await checkGitAvailable("/nonexistent/git")).toContain("找不到可用的 git");
  });
});

describe("runSelfCheck", () => {
  it("全部通过时返回空数组", async () => {
    const errors = await runSelfCheck({
      dataDir: path.join(tmp, "data"),
      backupDir: path.join(tmp, "backups"),
      inContainer: false,
    });
    expect(errors).toEqual([]);
  });

  it("容器内目录缺失时不自动创建，并汇总所有错误", async () => {
    const errors = await runSelfCheck(
      { dataDir: path.join(tmp, "data"), backupDir: path.join(tmp, "backups"), inContainer: true },
      "/nonexistent/git",
    );
    expect(errors).toHaveLength(3);
    await expect(fs.stat(path.join(tmp, "data"))).rejects.toThrow();
  });
});
