import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { KH_VERSION } from "@kanban-hub/core/version";
import { packCli } from "../scripts/pack.mjs";

const execFileAsync = promisify(execFile);

describe("kh 安装包", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await fs.rm(dir, { recursive: true, force: true });
    }
  });

  async function tmpDir(prefix: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    cleanupDirs.push(dir);
    return dir;
  }

  it("打包到指定的临时目录，不写 packages/cli/dist/", async () => {
    const outDir = await tmpDir("kh-pack-out-");
    const tgzPath = await packCli(outDir);

    expect(tgzPath).toBe(path.join(outDir, "kh.tgz"));
    await expect(fs.stat(tgzPath)).resolves.toBeTruthy();

    const defaultTgz = path.resolve(import.meta.dirname, "..", "dist", "kh.tgz");
    expect(tgzPath).not.toBe(defaultTgz);
  }, 30_000);

  it("包内容只有 package.json、kh.mjs、LICENSE，package.json 干净且版本号正确", async () => {
    const outDir = await tmpDir("kh-pack-out-");
    const tgzPath = await packCli(outDir);

    const { stdout: listing } = await execFileAsync("tar", ["-tzf", tgzPath]);
    const entries = listing
      .trim()
      .split("\n")
      .filter(Boolean)
      .sort();
    expect(entries).toEqual(["package/LICENSE", "package/kh.mjs", "package/package.json"]);

    const extractDir = await tmpDir("kh-pack-extract-");
    await execFileAsync("tar", ["-xzf", tgzPath, "-C", extractDir]);
    const pkg = JSON.parse(await fs.readFile(path.join(extractDir, "package", "package.json"), "utf8")) as Record<
      string,
      unknown
    >;

    expect(pkg.version).toBe(KH_VERSION);
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.devDependencies).toBeUndefined();
    expect((pkg.bin as Record<string, string> | undefined)?.kh).toBe("kh.mjs");
  }, 30_000);

  it.skipIf(process.platform === "win32")(
    "真实安装后可执行，版本号正确",
    async () => {
      const outDir = await tmpDir("kh-pack-out-");
      const tgzPath = await packCli(outDir);

      const installDir = await tmpDir("kh-pack-install-");
      const cacheDir = await tmpDir("kh-pack-cache-");

      await execFileAsync(
        "npm",
        [
          "install",
          "-g",
          "--prefix",
          installDir,
          tgzPath,
          "--cache",
          cacheDir,
          "--no-audit",
          "--no-fund",
        ],
        { timeout: 120_000 },
      );

      const binPath = path.join(installDir, "bin", "kh");
      const { stdout } = await execFileAsync(binPath, ["--version"]);
      expect(stdout.trim()).toBe(KH_VERSION);

      const stat = await fs.stat(binPath);
      expect(stat.mode & 0o111).not.toBe(0);
    },
    120_000,
  );
});
