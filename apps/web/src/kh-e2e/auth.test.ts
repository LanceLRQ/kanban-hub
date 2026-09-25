/**
 * kh login / logout / whoami 的端到端测试：用进程内测试服务端（真实路由处理函数 + 临时存储）
 * 驱动 cli 的 main()。少量用例改用 spawn 跑打包产物，验证真实进程的退出码。
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KH_VERSION } from "@kanban-hub/core/version";
import { readMachineConfig } from "../../../../packages/cli/src/config/home";
import { buildCli } from "../../../../packages/cli/scripts/build.mjs";
import { startTestServer, type TestServer } from "../server/api/test-server";
import { cleanupAll, makeTempKhHome, runKh, type RunKhResult, type TempDir } from "./harness";

const execFileAsync = promisify(execFile);

/** 监听一个空闲端口再立刻关掉，返回一个确定没有服务在监听的地址，用于测试"连不上服务端" */
async function unreachableUrl(): Promise<string> {
  const probe = http.createServer(() => {});
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => probe.close((err) => (err ? reject(err) : resolve())));
  return `http://127.0.0.1:${port}`;
}

describe("kh login / logout / whoami", () => {
  let server: TestServer;
  let home: TempDir;

  beforeEach(async () => {
    server = await startTestServer();
    home = await makeTempKhHome();
  });

  afterEach(async () => {
    await cleanupAll(home);
    await server.close();
  });

  describe("login", () => {
    it("成功后写出配置和凭据（权限 600），输出本机名", async () => {
      const { code } = server.issuePairingCode();
      const result = await runKh(["login", "--server", server.url, "--code", code, "--name", "我的笔记本"], {
        cwd: home.dir,
        khHome: home.dir,
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("我的笔记本");

      const stat = await fs.stat(path.join(home.dir, "credentials"));
      expect(stat.mode & 0o777).toBe(0o600);

      const cfg = await readMachineConfig(home.dir);
      expect(cfg?.server).toBe(server.url);
      expect(cfg?.machineName).toBe("我的笔记本");
      expect(cfg?.machineId).toBeDefined();
    });

    it("服务端的机器列表里多了一台，名称与 --name 一致", async () => {
      const { code } = server.issuePairingCode();
      const before = server.api.store.auth.listMachines().length;

      const result = await runKh(["login", "--server", server.url, "--code", code, "--name", "机器 A"], {
        cwd: home.dir,
        khHome: home.dir,
      });
      expect(result.code).toBe(0);

      const machines = server.api.store.auth.listMachines();
      expect(machines.length).toBe(before + 1);
      expect(machines.some((m) => m.name === "机器 A" && m.revokedAt === null)).toBe(true);
    });

    it("省略 --name 时默认取主机名，去掉 .local 后缀", async () => {
      const { code } = server.issuePairingCode();
      const result = await runKh(["login", "--server", server.url, "--code", code], { cwd: home.dir, khHome: home.dir });
      expect(result.code).toBe(0);

      const cfg = await readMachineConfig(home.dir);
      expect(cfg?.machineName).toBe(os.hostname().replace(/\.local$/, ""));
    });

    it("配对码错误，退出码 3", async () => {
      const result = await runKh(["login", "--server", server.url, "--code", "ZZZ-999", "--name", "x"], {
        cwd: home.dir,
        khHome: home.dir,
      });
      expect(result.code).toBe(3);
      expect(result.stderr.startsWith("错误：")).toBe(true);
    });

    it("配对码重复使用，第二次退出码 3", async () => {
      const { code } = server.issuePairingCode();
      const first = await runKh(["login", "--server", server.url, "--code", code, "--name", "机器一"], {
        cwd: home.dir,
        khHome: home.dir,
      });
      expect(first.code).toBe(0);

      const second = await runKh(["login", "--server", server.url, "--code", code, "--name", "机器二"], {
        cwd: home.dir,
        khHome: home.dir,
      });
      expect(second.code).toBe(3);
    });

    it("服务端地址不通，退出码 4", async () => {
      const deadUrl = await unreachableUrl();
      const result = await runKh(["login", "--server", deadUrl, "--code", "AAA-111", "--name", "x"], {
        cwd: home.dir,
        khHome: home.dir,
      });
      expect(result.code).toBe(4);
    });

    it("地址不是 http 或 https，退出码 2", async () => {
      const result = await runKh(["login", "--server", "ftp://example.test", "--code", "AAA-111", "--name", "x"], {
        cwd: home.dir,
        khHome: home.dir,
      });
      expect(result.code).toBe(2);
    });

    it("已登录时再次 login，覆盖本机配置，并提示旧的机器身份", async () => {
      const first = server.issuePairingCode();
      await runKh(["login", "--server", server.url, "--code", first.code, "--name", "旧机器"], {
        cwd: home.dir,
        khHome: home.dir,
      });
      const oldCfg = await readMachineConfig(home.dir);

      const second = server.issuePairingCode();
      const result = await runKh(["login", "--server", server.url, "--code", second.code, "--name", "新机器"], {
        cwd: home.dir,
        khHome: home.dir,
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("旧机器");
      expect(result.stdout).toContain(String(oldCfg?.machineId));

      const newCfg = await readMachineConfig(home.dir);
      expect(newCfg?.machineName).toBe("新机器");
      expect(newCfg?.machineId).not.toBe(oldCfg?.machineId);
    });

    it("省略 --server 时沿用已有配置里的地址", async () => {
      const first = server.issuePairingCode();
      await runKh(["login", "--server", server.url, "--code", first.code, "--name", "机器一"], {
        cwd: home.dir,
        khHome: home.dir,
      });

      const second = server.issuePairingCode();
      const result = await runKh(["login", "--code", second.code, "--name", "机器二"], { cwd: home.dir, khHome: home.dir });

      expect(result.code).toBe(0);
      const cfg = await readMachineConfig(home.dir);
      expect(cfg?.server).toBe(server.url);
    });

    it("从未登录过又省略 --server 时是用法错误，退出码 2", async () => {
      const result = await runKh(["login", "--code", "AAA-111"], { cwd: home.dir, khHome: home.dir });
      expect(result.code).toBe(2);
    });

    it("连续输错配对码触发 429，退出码 3，提示里带等待秒数", async () => {
      let last: RunKhResult | undefined;
      for (let i = 0; i < 6; i++) {
        last = await runKh(["login", "--server", server.url, "--code", "ZZZ-000", "--name", "x"], {
          cwd: home.dir,
          khHome: home.dir,
        });
      }
      expect(last?.code).toBe(3);
      expect(last?.stderr).toContain("提示：");
      expect(last?.stderr).toMatch(/\d+\s*秒/);
    });

    it("令牌不出现在 stdout/stderr 里", async () => {
      const { code } = server.issuePairingCode();
      const result = await runKh(["login", "--server", server.url, "--code", code, "--name", "x"], {
        cwd: home.dir,
        khHome: home.dir,
      });
      const token = (await fs.readFile(path.join(home.dir, "credentials"), "utf8")).trim();
      expect(token.length).toBeGreaterThan(0);
      expect(result.stdout).not.toContain(token);
      expect(result.stderr).not.toContain(token);
    });
  });

  describe("whoami", () => {
    it("正常输出：服务端地址、用户、本机、版本", async () => {
      const { code } = server.issuePairingCode();
      await runKh(["login", "--server", server.url, "--code", code, "--name", "我的电脑"], { cwd: home.dir, khHome: home.dir });

      const result = await runKh(["whoami"], { cwd: home.dir, khHome: home.dir });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(server.url);
      expect(result.stdout).toContain("我的电脑");
      expect(result.stdout).toContain(KH_VERSION);
    });

    it("未登录，退出码 3", async () => {
      const result = await runKh(["whoami"], { cwd: home.dir, khHome: home.dir });
      expect(result.code).toBe(3);
    });

    it("本机被吊销后，退出码 3，并带 /setup 的提示", async () => {
      const { code } = server.issuePairingCode();
      await runKh(["login", "--server", server.url, "--code", code, "--name", "会被吊销的机器"], {
        cwd: home.dir,
        khHome: home.dir,
      });
      const machine = server.api.store.auth.listMachines().find((m) => m.name === "会被吊销的机器");
      if (!machine) throw new Error("测试前置条件失败：找不到刚登录的机器");
      await server.api.store.auth.updateMachine(machine.id, { revokedAt: new Date().toISOString() });

      const result = await runKh(["whoami"], { cwd: home.dir, khHome: home.dir });
      expect(result.code).toBe(3);
      expect(result.stderr).toContain("/setup");
    });
  });

  describe("agent 识别透传到 X-KH-Agent（agent 解析收在 requireLogin 里，写命令不用各自处理）", () => {
    it("--agent 覆盖环境变量识别结果", async () => {
      const { code } = server.issuePairingCode();
      await runKh(["login", "--server", server.url, "--code", code, "--name", "x"], { cwd: home.dir, khHome: home.dir });

      const result = await runKh(["--agent", "custom-agent", "whoami"], {
        cwd: home.dir,
        khHome: home.dir,
        env: { CLAUDECODE: "1" },
      });
      expect(result.code).toBe(0);
      expect(server.lastRequestHeaders()?.["x-kh-agent"]).toBe("custom-agent");
    });

    it("没给 --agent 时按环境变量对照表识别", async () => {
      const { code } = server.issuePairingCode();
      await runKh(["login", "--server", server.url, "--code", code, "--name", "x"], { cwd: home.dir, khHome: home.dir });

      const result = await runKh(["whoami"], { cwd: home.dir, khHome: home.dir, env: { CLAUDECODE: "1" } });
      expect(result.code).toBe(0);
      expect(server.lastRequestHeaders()?.["x-kh-agent"]).toBe("claude-code");
    });

    it("--agent 不合法（中文）时退出码 2，未登录和已登录都一样：本地校验优先于登录检查", async () => {
      const unloggedIn = await runKh(["--agent", "验收脚本", "whoami"], { cwd: home.dir, khHome: home.dir });
      expect(unloggedIn.code).toBe(2);
      expect(unloggedIn.stderr.startsWith("错误：")).toBe(true);

      const { code } = server.issuePairingCode();
      await runKh(["login", "--server", server.url, "--code", code, "--name", "x"], { cwd: home.dir, khHome: home.dir });

      const loggedIn = await runKh(["--agent", "验收脚本", "whoami"], { cwd: home.dir, khHome: home.dir });
      expect(loggedIn.code).toBe(2);
      expect(loggedIn.stderr.startsWith("错误：")).toBe(true);
    });
  });

  describe("logout", () => {
    it("删除凭据后 whoami 返回 3，服务端地址保留在配置里", async () => {
      const { code } = server.issuePairingCode();
      await runKh(["login", "--server", server.url, "--code", code, "--name", "x"], { cwd: home.dir, khHome: home.dir });

      const logoutResult = await runKh(["logout"], { cwd: home.dir, khHome: home.dir });
      expect(logoutResult.code).toBe(0);

      await expect(fs.stat(path.join(home.dir, "credentials"))).rejects.toThrow();

      const whoamiResult = await runKh(["whoami"], { cwd: home.dir, khHome: home.dir });
      expect(whoamiResult.code).toBe(3);

      const cfg = await readMachineConfig(home.dir);
      expect(cfg?.server).toBe(server.url);
      expect(cfg?.machineId).toBeUndefined();
    });
  });
});

describe("kh whoami：真实进程", () => {
  let outfile: string;
  let buildDir: string;
  let server: TestServer;

  beforeAll(async () => {
    buildDir = await fs.mkdtemp(path.join(os.tmpdir(), "kh-e2e-bundle-"));
    outfile = await buildCli(path.join(buildDir, "kh.mjs"));
  }, 30_000);

  afterAll(async () => {
    await fs.rm(buildDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    server = await startTestServer();
  });

  afterEach(async () => {
    await server.close();
  });

  async function spawnKh(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [outfile, ...args], { env });
      return { code: 0, stdout, stderr };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
  }

  it("登录后 kh whoami 返回 0", async () => {
    const home = await makeTempKhHome();
    try {
      const { code } = server.issuePairingCode();
      const loginResult = await runKh(["login", "--server", server.url, "--code", code, "--name", "真实进程测试机"], {
        cwd: home.dir,
        khHome: home.dir,
      });
      expect(loginResult.code).toBe(0);

      const result = await spawnKh(["whoami"], { ...process.env, KH_HOME: home.dir });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("真实进程测试机");
    } finally {
      await home.cleanup();
    }
  }, 30_000);

  it("未登录时 kh whoami 返回 3", async () => {
    const home = await makeTempKhHome();
    try {
      const result = await spawnKh(["whoami"], { ...process.env, KH_HOME: home.dir });
      expect(result.code).toBe(3);
    } finally {
      await home.cleanup();
    }
  }, 30_000);
});
