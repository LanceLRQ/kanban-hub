import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { KH_VERSION } from "@kanban-hub/core/version";
import { buildCli } from "../scripts/build.mjs";

const execFileAsync = promisify(execFile);
const srcDir = path.dirname(fileURLToPath(import.meta.url));

describe("kh 打包产物", () => {
  let dir: string;
  let outfile: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "kh-bundle-"));
    outfile = await buildCli(path.join(dir, "kh.mjs"));
  }, 30_000);

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("单个文件即可运行并输出版本号", async () => {
    const { stdout } = await execFileAsync(process.execPath, [outfile, "--version"]);
    expect(stdout.trim()).toBe(KH_VERSION);
  });

  it("首行是 node 的 shebang", async () => {
    const firstLine = (await fs.readFile(outfile, "utf8")).split("\n", 1)[0];
    expect(firstLine).toBe("#!/usr/bin/env node");
  });

  it("子命令的用法错误走 kh 自己的退出码约定，而不是 commander 默认的 process.exit(1)", async () => {
    // kh login --server 缺少参数值：commander 会在 login 这个子命令上报错，
    // 真实进程里验证它没有绕过 main.ts 的错误映射（退出码 2、stderr 以“错误：”开头）
    let failed: { code?: number | null; stderr?: string } | undefined;
    try {
      await execFileAsync(process.execPath, [outfile, "login", "--server"]);
    } catch (err) {
      failed = err as { code?: number | null; stderr?: string };
    }
    expect(failed).toBeDefined();
    expect(failed?.code).toBe(2);
    expect(failed?.stderr?.startsWith("错误：")).toBe(true);
  });

  it("kh -v 返回 0 并打印版本号（不会被子命令的同名选项截走）", async () => {
    const { stdout } = await execFileAsync(process.execPath, [outfile, "-v"]);
    expect(stdout.trim()).toBe(KH_VERSION);
  });

  it("kh container add … --version 不会被根命令的 -v/--version 截走：未登录、未注册的目录里退出码不是 0，stdout 不是版本号", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "kh-bundle-cwd-"));
    const khHome = await fs.mkdtemp(path.join(os.tmpdir(), "kh-bundle-home-"));
    try {
      let failed: { code?: number | null; stdout?: string } | undefined;
      try {
        await execFileAsync(process.execPath, [outfile, "container", "add", "phase", "X", "--version", "v1"], {
          cwd,
          env: { ...process.env, KH_HOME: khHome },
        });
      } catch (err) {
        failed = err as { code?: number | null; stdout?: string };
      }
      expect(failed).toBeDefined();
      expect(failed?.code).not.toBe(0);
      expect((failed?.stdout ?? "").trim()).not.toBe(KH_VERSION);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
      await fs.rm(khHome, { recursive: true, force: true });
    }
  });

  it("kh login --server 带账号密码：退出码 2，stderr 不回显密码", async () => {
    const khHome = await fs.mkdtemp(path.join(os.tmpdir(), "kh-bundle-home-"));
    try {
      let failed: { code?: number | null; stderr?: string } | undefined;
      try {
        await execFileAsync(process.execPath, [outfile, "login", "--server", "http://u:p@127.0.0.1:1", "--code", "x"], {
          env: { ...process.env, KH_HOME: khHome },
        });
      } catch (err) {
        failed = err as { code?: number | null; stderr?: string };
      }
      expect(failed).toBeDefined();
      expect(failed?.code).toBe(2);
      expect(failed?.stderr ?? "").not.toContain("p@");
    } finally {
      await fs.rm(khHome, { recursive: true, force: true });
    }
  });
});

describe("同步扫描依赖（picomatch）打包后能正常运行", () => {
  // sync/scan.ts 目前还没有被任何命令引用（本任务不新增命令），单独把它打成一个入口验证
  // picomatch 真的被打进产物、且在 esbuild 的 ESM 产物里能正常工作（CJS 依赖在打包时最容易
  // 出这类问题，M3 已经因为 commander 踩过一次）
  it("bundle 后调用 scanSyncFiles / matchesSyncScope 结果正确", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kh-bundle-scan-"));
    try {
      const fixtureRoot = path.join(dir, "fixture");
      await fs.mkdir(path.join(fixtureRoot, "docs"), { recursive: true });
      await fs.writeFile(path.join(fixtureRoot, "docs", "a.md"), "hello");

      const entry = path.join(dir, "entry.ts");
      await fs.writeFile(
        entry,
        [
          `import { scanSyncFiles, matchesSyncScope } from ${JSON.stringify(path.join(srcDir, "sync", "scan.ts"))};`,
          "const root = process.argv[2];",
          'const scope = { include: ["docs/**"], exclude: [], maxFileSize: 1024 * 1024 };',
          "const result = await scanSyncFiles(root, scope);",
          'console.log(JSON.stringify({ files: result.files.map((f) => f.path), matches: matchesSyncScope("docs/a.md", scope) }));',
        ].join("\n"),
        "utf8",
      );

      const outfile = path.join(dir, "entry.mjs");
      await build({ entryPoints: [entry], outfile, bundle: true, platform: "node", target: "node22", format: "esm", logLevel: "warning" });

      const bundled = await fs.readFile(outfile, "utf8");
      // picomatch 的代码确实进了产物，不是被 tree-shaking 掉了
      expect(bundled).toContain("picomatch");

      const { stdout } = await execFileAsync(process.execPath, [outfile, fixtureRoot]);
      expect(JSON.parse(stdout.trim())).toEqual({ files: ["docs/a.md"], matches: true });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
