import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { KH_VERSION } from "@kanban-hub/core/version";
import { buildCli } from "../scripts/build.mjs";

const execFileAsync = promisify(execFile);

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
