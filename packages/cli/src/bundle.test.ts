import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { KH_VERSION } from "@kanban-hub/core/version";
import { buildCli } from "../scripts/build.mjs";
import { SKILL_MD } from "./setup/skill";
import { writeMachineConfig, writeToken } from "./config/home";
import { createMarkerIfAbsent } from "./hook/marker";
import { STOP_REMINDER } from "./hook/stop";
import { writeRepoConfig } from "./repo/config";

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

  it("kh sync --help、kh docs ls --help：退出码 0（新命令的解析和 picomatch 依赖在真实产物上验证）", async () => {
    const sync = await execFileAsync(process.execPath, [outfile, "sync", "--help"]);
    expect(sync.stdout).toContain("sync");

    const docsLs = await execFileAsync(process.execPath, [outfile, "docs", "ls", "--help"]);
    expect(docsLs.stdout).toContain("ls");
  });

  it("kh pull --help、kh conflicts show --help：退出码 0", async () => {
    const pull = await execFileAsync(process.execPath, [outfile, "pull", "--help"]);
    expect(pull.stdout).toContain("--dry-run");

    const show = await execFileAsync(process.execPath, [outfile, "conflicts", "show", "--help"]);
    expect(show.stdout).toContain("show");
  });

  it("kh import --help、kh export --help：退出码 0", async () => {
    const imp = await execFileAsync(process.execPath, [outfile, "import", "--help"]);
    expect(imp.stdout).toContain("--dry-run");

    const exp = await execFileAsync(process.execPath, [outfile, "export", "--help"]);
    expect(exp.stdout).toContain("--md");
  });

  it("kh setup --help：退出码 0", async () => {
    const { stdout } = await execFileAsync(process.execPath, [outfile, "setup", "--help"]);
    expect(stdout).toContain("setup");
  });

  it("kh setup --dry-run、kh setup --yes：在临时 HOME 下写出与源码逐字相同的 SKILL.md", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "kh-bundle-home-setup-"));
    try {
      await fs.mkdir(path.join(home, ".claude"), { recursive: true });

      const { stdout: dryRunOut } = await execFileAsync(process.execPath, [outfile, "setup", "--dry-run"], {
        env: { ...process.env, HOME: home },
      });
      const agentSkillPath = path.join(home, ".agents", "skills", "kanban-hub", "SKILL.md");
      const claudeSkillPath = path.join(home, ".claude", "skills", "kanban-hub", "SKILL.md");
      expect(dryRunOut).toContain(agentSkillPath);
      expect(dryRunOut).toContain(claudeSkillPath);
      // --dry-run 不写入任何内容
      await expect(fs.stat(agentSkillPath)).rejects.toThrow();

      await execFileAsync(process.execPath, [outfile, "setup", "--yes"], {
        env: { ...process.env, HOME: home },
      });
      expect(await fs.readFile(agentSkillPath, "utf8")).toBe(SKILL_MD);
      expect(await fs.readFile(claudeSkillPath, "utf8")).toBe(SKILL_MD);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  describe("kh hook（真实进程）", () => {
    const PROJECT_ID = "p000000001";
    const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const git = (args: string[], cwd: string) =>
      execFileSync("git", ["-c", "user.name=kh", "-c", "user.email=kh@example.com", "-c", "commit.gpgsign=false", ...args], {
        cwd,
        env: GIT_ENV,
        encoding: "utf8",
      });

    let root: string;
    let repo: string;
    let tcp: net.Server;
    let sockets: net.Socket[];
    let tcpUrl: string;
    const spawnedPids: number[] = [];

    beforeAll(async () => {
      root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "kh-bundle-hook-")));
      repo = path.join(root, "repo");
      await fs.mkdir(repo);
      git(["init", "-q"], repo);
      git(["commit", "--allow-empty", "-q", "-m", "init"], repo);
      await writeRepoConfig(repo, {
        projectId: PROJECT_ID,
        sync: { include: [], exclude: [], maxFileSize: 5 * 1024 * 1024 },
        pull: { auto: true },
      });

      // 只接受连接、从不响应：让后台同步挂在请求上
      sockets = [];
      tcp = net.createServer((socket) => {
        sockets.push(socket);
        socket.on("error", () => {});
      });
      await new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", resolve));
      tcpUrl = `http://127.0.0.1:${(tcp.address() as net.AddressInfo).port}`;
    });

    afterAll(async () => {
      for (const pid of spawnedPids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // 已经退出
        }
      }
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => tcp.close(() => resolve()));
      await fs.rm(root, { recursive: true, force: true });
    });

    async function freshHome(name: string, loggedIn: boolean): Promise<{ home: string; khHome: string }> {
      const home = path.join(root, `${name}-home`);
      const khHome = path.join(root, `${name}-kh`);
      await fs.mkdir(home, { recursive: true });
      await fs.mkdir(khHome, { recursive: true });
      if (loggedIn) {
        await writeMachineConfig(khHome, { server: tcpUrl, machineId: "m000000001", machineName: "冒烟机" });
        await writeToken(khHome, `kh_${"a".repeat(43)}`);
      }
      return { home, khHome };
    }

    interface Finished {
      code: number | null;
      stdout: string;
      stderr: string;
      elapsedMs: number;
    }

    /** 执行打包产物，stdin 写完就关闭；回调在 stdout、stderr 管道都关闭之后才触发 */
    function runBundled(args: string[], env: NodeJS.ProcessEnv, stdin: string): Promise<Finished> {
      const started = Date.now();
      return new Promise((resolve) => {
        const child = execFile(process.execPath, [outfile, ...args], { env, cwd: repo, timeout: 20_000 }, (err, stdout, stderr) => {
          const code = err ? ((err as { code?: number | null }).code ?? null) : 0;
          resolve({ code, stdout: String(stdout), stderr: String(stderr), elapsedMs: Date.now() - started });
        });
        child.stdin?.end(stdin);
      });
    }

    async function waitForLockPid(khHome: string, timeoutMs: number): Promise<number | null> {
      const lock = path.join(khHome, "cache", PROJECT_ID, "lock");
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        try {
          const content = JSON.parse(await fs.readFile(lock, "utf8")) as { pid?: number };
          if (typeof content.pid === "number") return content.pid;
        } catch {
          // 还没创建或正在写
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      return null;
    }

    function pgidOf(pid: number): number {
      return Number.parseInt(execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim(), 10);
    }

    it("kh hook stop：3 秒内结束、退出码 0（后台进程没有继承输出管道）；后台的 hook sync 仍在运行，进程组与 hook 不同", async () => {
      const { home, khHome } = await freshHome("bg", true);
      const env = { ...process.env, HOME: home, KH_HOME: khHome };
      const result = await runBundled(["hook", "stop"], env, JSON.stringify({ session_id: "smoke-bg", cwd: repo }));
      expect(result.code).toBe(0);
      expect(result.elapsedMs).toBeLessThan(3000);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");

      const pid = await waitForLockPid(khHome, 5000);
      expect(pid).not.toBeNull();
      spawnedPids.push(pid!);
      expect(() => process.kill(pid!, 0)).not.toThrow();
      // hook 进程没有 detached，与本测试进程同组；后台进程自成一组
      expect(pgidOf(pid!)).toBe(pid);
      expect(pgidOf(pid!)).not.toBe(pgidOf(process.pid));
      expect(await fs.readFile(path.join(khHome, "logs", "hook.log"), "utf8")).toContain("已在后台启动同步");
    }, 20_000);

    it("kh hook stop 走提醒路径：退出码 2，stderr 与提醒原文完全一致", async () => {
      const { home, khHome } = await freshHome("remind", false);
      await createMarkerIfAbsent(khHome, {
        sessionId: "smoke-remind",
        projectId: PROJECT_ID,
        root: repo,
        worktree: repo,
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        head: "0".repeat(40),
        dirty: null,
        reminded: false,
      });
      const env = { ...process.env, HOME: home, KH_HOME: khHome };
      const result = await runBundled(["hook", "stop"], env, JSON.stringify({ session_id: "smoke-remind", cwd: repo }));
      expect(result.code).toBe(2);
      expect(result.stderr).toBe(STOP_REMINDER);
      expect(result.stdout).toBe("");
    }, 20_000);

    it("stderr 的读端提前关闭（EPIPE）：提醒路径仍按 hook 的退出码 2 结束，不崩溃成退出码 1", async () => {
      const { home, khHome } = await freshHome("epipe", false);
      await createMarkerIfAbsent(khHome, {
        sessionId: "smoke-epipe",
        projectId: PROJECT_ID,
        root: repo,
        worktree: repo,
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        head: "0".repeat(40),
        dirty: null,
        reminded: false,
      });
      const child = spawn(process.execPath, [outfile, "hook", "stop"], {
        env: { ...process.env, HOME: home, KH_HOME: khHome },
        cwd: repo,
        stdio: ["pipe", "pipe", "pipe"],
      });
      // 读端在写入之前就关掉：子进程写提醒时会遇到 EPIPE
      child.stderr.destroy();
      child.stdout.destroy();
      child.stdin.end(JSON.stringify({ session_id: "smoke-epipe", cwd: repo }));
      const code = await new Promise<number | null>((resolve) => child.on("close", (c) => resolve(c)));
      expect(code).toBe(2);
      // 标记确实走到了提醒这一步
      const marker = JSON.parse(await fs.readFile(path.join(khHome, "cache", "sessions", "smoke-epipe.json"), "utf8")) as { reminded: boolean };
      expect(marker.reminded).toBe(true);
    }, 20_000);

    it("stdin 管道一直不关闭：kh hook stop 3 秒内退出，退出码 0", async () => {
      const { home, khHome } = await freshHome("stdin", false);
      const started = Date.now();
      const child = spawn(process.execPath, [outfile, "hook", "stop"], {
        env: { ...process.env, HOME: home, KH_HOME: khHome },
        cwd: repo,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      const code = await new Promise<number | null>((resolve) => child.on("close", (c) => resolve(c)));
      child.stdin.destroy();
      expect(Date.now() - started).toBeLessThan(3000);
      expect(code).toBe(0);
      expect(stderr).toBe("");
    }, 20_000);

    it("kh hook session-start 的 stdin 为空：退出码 0，stdout 为空", async () => {
      const { home, khHome } = await freshHome("empty", true);
      const result = await runBundled(["hook", "session-start"], { ...process.env, HOME: home, KH_HOME: khHome }, "");
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    }, 20_000);
  });
});
