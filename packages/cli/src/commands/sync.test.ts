import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXIT } from "../errors";
import { main } from "../main";
import { writeRepoConfig } from "../repo/config";
import { cleanupDir, fakeContext, makeTempDir } from "../repo/test-helpers";

const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) await cleanupDir(dir);
  }
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await makeTempDir(prefix);
  dirs.push(dir);
  return dir;
}

/** 已注册（有仓库配置）但本机没有登录信息的仓库，仓库里放一个文档和一个虚拟环境目录 */
async function registeredRepo(): Promise<string> {
  const root = await tempDir("kh-sync-cmd-repo-");
  await fs.mkdir(path.join(root, "docs", "env1"), { recursive: true });
  await fs.writeFile(path.join(root, "docs", "a.md"), "hello");
  await fs.writeFile(path.join(root, "docs", "env1", "pyvenv.cfg"), "");
  await writeRepoConfig(root, {
    projectId: "p000000001",
    sync: { include: ["docs/**"], exclude: [], maxFileSize: "5MB" },
    pull: { auto: true },
  });
  return root;
}

describe("kh sync --dry-run", () => {
  it("不要求登录、不发任何请求、不在 KH_HOME 里留下任何文件，退出码 0", async () => {
    const root = await registeredRepo();
    const khHome = await tempDir("kh-sync-cmd-home-");
    const fetchSpy = vi.fn(() => {
      throw new Error("dry-run 不应该联网");
    });
    let out = "";
    const ctx = fakeContext({
      cwd: root,
      env: { ...process.env, KH_HOME: khHome },
      stdout: { write: (s) => void (out += String(s)) },
      fetch: fetchSpy as unknown as typeof fetch,
    });
    expect(await main(["sync", "--dry-run"], ctx)).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out).toContain("将同步 1 个文件");
    expect(out).toContain("docs/env1  Python 虚拟环境");
    expect(await fs.readdir(khHome)).toEqual([]);
  });

  it("仓库没有注册时退出码 2", async () => {
    const root = await tempDir("kh-sync-cmd-bare-");
    const khHome = await tempDir("kh-sync-cmd-home-");
    const ctx = fakeContext({ cwd: root, env: { ...process.env, KH_HOME: khHome }, homeDir: root });
    expect(await main(["sync", "--dry-run"], ctx)).toBe(EXIT.USAGE);
  });

  it("不带 --dry-run 且未登录时仍然退出码 3", async () => {
    const root = await registeredRepo();
    const khHome = await tempDir("kh-sync-cmd-home-");
    const ctx = fakeContext({ cwd: root, env: { ...process.env, KH_HOME: khHome } });
    expect(await main(["sync"], ctx)).toBe(EXIT.AUTH);
  });
});
