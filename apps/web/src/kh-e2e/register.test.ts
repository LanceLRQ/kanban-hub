/**
 * kh register 的端到端测试：用进程内测试服务端（真实路由处理函数 + 临时存储）驱动 cli 的 main()。
 * 每个用例独立起一个 TestServer，避免不同用例之间的项目数据互相干扰。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readRepoConfig } from "../../../../packages/cli/src/repo/config";
import { startTestServer, type TestServer } from "../server/api/test-server";
import { cleanupAll, makeTempKhHome, makeTempRepo, runKh, type MakeTempRepoOptions, type TempDir, type TempRepo } from "./harness";

/** git status --porcelain 的输出；用来断言 register 没有留下任何 git 能看到的改动 */
function gitStatusPorcelain(cwd: string): string {
  return execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }).trim();
}

async function makeRealTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return fs.realpath(dir);
}

/**
 * 只复制一份 .git 目录到全新的工作目录：得到指纹相同（rev-list 只看 .git 的对象和引用），
 * 但没有工作区文件、也没有 .kanban-hub 配置的“另一个仓库”——用来构造两个指纹相同的独立仓库。
 */
async function cloneGitHistory(sourceDir: string): Promise<TempDir> {
  const dir = await makeRealTempDir("kh-e2e-fp-clone-");
  await fs.cp(path.join(sourceDir, ".git"), path.join(dir, ".git"), { recursive: true });
  return { dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

/** 完整复制一份仓库目录（含 .git 和 .kanban-hub）：模拟“配置文件已经入库，在另一台机器上克隆” */
async function copyRepoDir(sourceDir: string): Promise<TempDir> {
  const dir = await makeRealTempDir("kh-e2e-full-clone-");
  await fs.cp(sourceDir, dir, { recursive: true });
  return { dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

describe("kh register", () => {
  let server: TestServer;
  const cleanupItems: TempDir[] = [];

  beforeEach(async () => {
    server = await startTestServer();
  });

  afterEach(async () => {
    await cleanupAll(...cleanupItems);
    cleanupItems.length = 0;
    await server.close();
  });

  async function tempRepo(opts?: MakeTempRepoOptions): Promise<TempRepo> {
    const repo = await makeTempRepo(opts);
    cleanupItems.push(repo);
    return repo;
  }

  async function tempHome(): Promise<TempDir> {
    const home = await makeTempKhHome();
    cleanupItems.push(home);
    return home;
  }

  /** 建一个临时 KH_HOME 并登录，模拟“另一台机器” */
  async function loginHome(): Promise<TempDir> {
    const home = await tempHome();
    const { code } = server.issuePairingCode();
    const result = await runKh(["login", "--server", server.url, "--code", code], { cwd: home.dir, khHome: home.dir });
    if (result.code !== 0) throw new Error(`测试前置条件失败：登录没有成功（${result.stderr}）`);
    return home;
  }

  describe("新建", () => {
    it("新仓库 --new --yes：项目、指纹、位置、同步范围正确；本地写出配置并在 info/exclude 里排除；git 状态干净", async () => {
      const repo = await tempRepo();
      const home = await loginHome();

      const result = await runKh(["register", "--new", "--yes"], {
        cwd: repo.dir,
        khHome: home.dir,
        env: { CLAUDECODE: "1" },
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("kh status");

      const projects = server.api.store.listProjects();
      expect(projects).toHaveLength(1);
      const project = projects[0]!;
      expect(project.fingerprint).toBe(repo.commitHashes[0]);
      expect(project.locations).toHaveLength(1);
      const location = project.locations[0]!;
      expect(location.path).toBe(repo.dir);
      expect(location.sync).toEqual({ include: [], exclude: [], maxFileSize: 5 * 1024 * 1024 });

      const config = await readRepoConfig(repo.dir);
      expect(config?.projectId).toBe(project.id);
      expect(config?.sync.include).toEqual([]);
      expect(config?.pull.auto).toBe(true);

      const exclude = await fs.readFile(path.join(repo.dir, ".git", "info", "exclude"), "utf8");
      expect(exclude).toContain("/.kanban-hub/");

      expect(gitStatusPorcelain(repo.dir)).toBe("");

      const events = await server.api.store.listEvents({ projectId: project.id, limit: 20 });
      expect(events.some((e) => e.type === "project.created" && e.actor.agent === "claude-code")).toBe(true);
      expect(events.some((e) => e.type === "project.updated" && e.actor.agent === "claude-code")).toBe(true);
    });

    it("--include 覆盖建议值；glob 不合法时退出码 2", async () => {
      const repo = await tempRepo();
      const home = await loginHome();

      const invalid = await runKh(["register", "--new", "--yes", "--include", "/abs/not/allowed"], {
        cwd: repo.dir,
        khHome: home.dir,
      });
      expect(invalid.code).toBe(2);
      expect(server.api.store.listProjects()).toHaveLength(0);

      const ok = await runKh(["register", "--new", "--yes", "--include", "docs/**", "--include", "*.md"], {
        cwd: repo.dir,
        khHome: home.dir,
      });
      expect(ok.code).toBe(0);

      const config = await readRepoConfig(repo.dir);
      expect(config?.sync.include).toEqual(["docs/**", "*.md"]);
    });
  });

  describe("绑定", () => {
    it("单一匹配默认建议绑定；--bind 全 ID 和前缀都能定位；绑定后项目多出位置", async () => {
      const repoA = await tempRepo();
      const home1 = await loginHome();
      const first = await runKh(["register", "--new", "--yes"], { cwd: repoA.dir, khHome: home1.dir });
      expect(first.code).toBe(0);
      const project = server.api.store.listProjects()[0]!;

      const cloneB = await cloneGitHistory(repoA.dir);
      cleanupItems.push(cloneB);
      const home2 = await loginHome();

      const dryRun = await runKh(["register", "--dry-run"], { cwd: cloneB.dir, khHome: home2.dir });
      expect(dryRun.code).toBe(0);
      expect(dryRun.stdout).toContain("绑定到已有项目");
      expect(dryRun.stdout).toContain(project.id);

      const bindFull = await runKh(["register", "--bind", project.id, "--yes"], { cwd: cloneB.dir, khHome: home2.dir });
      expect(bindFull.code).toBe(0);
      expect(server.api.store.getProject(project.id)?.locations).toHaveLength(2);

      const cloneC = await cloneGitHistory(repoA.dir);
      cleanupItems.push(cloneC);
      const home3 = await loginHome();
      const bindPrefix = await runKh(["register", "--bind", project.id.slice(0, 4), "--yes"], {
        cwd: cloneC.dir,
        khHome: home3.dir,
      });
      expect(bindPrefix.code).toBe(0);
      expect(server.api.store.getProject(project.id)?.locations).toHaveLength(3);
    });

    it("--bind 找不到匹配的项目，退出码 5", async () => {
      const repo = await tempRepo();
      const home = await loginHome();
      const result = await runKh(["register", "--bind", "zzzzzzzzzz", "--yes"], { cwd: repo.dir, khHome: home.dir });
      expect(result.code).toBe(5);
    });
  });

  describe("多个匹配", () => {
    it("两个项目指纹相同：不带 --bind 返回 2 并列出两个项目；--new 遇到已匹配的指纹会警告", async () => {
      const repoA = await tempRepo();
      const cloneB = await cloneGitHistory(repoA.dir);
      cleanupItems.push(cloneB);
      const cloneC = await cloneGitHistory(repoA.dir);
      cleanupItems.push(cloneC);

      const home1 = await loginHome();
      const first = await runKh(["register", "--new", "--yes"], { cwd: repoA.dir, khHome: home1.dir });
      expect(first.code).toBe(0);

      const home2 = await loginHome();
      const second = await runKh(["register", "--new", "--yes"], { cwd: cloneB.dir, khHome: home2.dir });
      expect(second.code).toBe(0);
      expect(second.stdout).toContain("警告");

      const projects = server.api.store.listProjects();
      expect(projects).toHaveLength(2);
      const [p1, p2] = projects;

      const home3 = await loginHome();
      const third = await runKh(["register", "--yes"], { cwd: cloneC.dir, khHome: home3.dir });
      expect(third.code).toBe(2);
      expect(third.stderr).toContain(p1!.name);
      expect(third.stderr).toContain(p2!.name);
    });
  });

  describe("不是 git 仓库", () => {
    it("能用 --new 注册，指纹为 null，不写 info/exclude", async () => {
      const repo = await tempRepo({ git: false });
      const home = await loginHome();

      const result = await runKh(["register", "--new", "--yes"], { cwd: repo.dir, khHome: home.dir });
      expect(result.code).toBe(0);

      const config = await readRepoConfig(repo.dir);
      expect(config).not.toBeNull();
      const project = server.api.store.getProject(config!.projectId);
      expect(project?.fingerprint).toBeNull();

      await expect(fs.stat(path.join(repo.dir, ".git"))).rejects.toThrow();
    });
  });

  describe("--dry-run", () => {
    it("只打印计划，不新建项目，也不写入任何本地文件", async () => {
      const repo = await tempRepo();
      const home = await loginHome();
      const before = server.api.store.listProjects().length;

      const result = await runKh(["register", "--new", "--dry-run"], { cwd: repo.dir, khHome: home.dir });
      expect(result.code).toBe(0);
      expect(server.api.store.listProjects().length).toBe(before);
      await expect(fs.stat(path.join(repo.dir, ".kanban-hub"))).rejects.toThrow();

      for (const keyword of ["仓库根", "指纹", "同步范围", "将要写入的文件", "将要调用的接口"]) {
        expect(result.stdout).toContain(keyword);
      }
      expect(result.stdout).toContain(repo.dir);
    });
  });

  describe("确认", () => {
    it("非交互环境不带 --yes：返回 2，仍然打印计划", async () => {
      const repo = await tempRepo();
      const home = await loginHome();
      const result = await runKh(["register", "--new"], { cwd: repo.dir, khHome: home.dir });
      expect(result.code).toBe(2);
      expect(result.stdout).toContain("仓库根");
    });

    it("交互环境输入 n：什么也不做，退出码 0", async () => {
      const repo = await tempRepo();
      const home = await loginHome();
      const before = server.api.store.listProjects().length;

      const result = await runKh(["register", "--new"], { cwd: repo.dir, khHome: home.dir, isTTY: true, stdin: "n\n" });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("已取消");
      expect(server.api.store.listProjects().length).toBe(before);
    });

    it("交互环境输入 y：照常执行", async () => {
      const repo = await tempRepo();
      const home = await loginHome();
      const before = server.api.store.listProjects().length;

      const result = await runKh(["register", "--new"], { cwd: repo.dir, khHome: home.dir, isTTY: true, stdin: "y\n" });
      expect(result.code).toBe(0);
      expect(server.api.store.listProjects().length).toBe(before + 1);
    });
  });

  describe("已有配置", () => {
    it("本机已登记且路径一致：显示信息，退出码 0，不发写请求", async () => {
      const repo = await tempRepo();
      const home = await loginHome();
      const first = await runKh(["register", "--new", "--yes"], { cwd: repo.dir, khHome: home.dir });
      expect(first.code).toBe(0);

      const spy = vi.spyOn(server.api.store, "setLocation");
      const second = await runKh(["register"], { cwd: repo.dir, khHome: home.dir });
      expect(second.code).toBe(0);
      expect(spy).not.toHaveBeenCalled();
      expect(second.stdout).toContain(repo.dir);
    });

    it("配置已入库，在另一台机器克隆后执行，补登记本机位置", async () => {
      const repo = await tempRepo();
      const home1 = await loginHome();
      const first = await runKh(["register", "--new", "--yes"], { cwd: repo.dir, khHome: home1.dir });
      expect(first.code).toBe(0);

      const clone = await copyRepoDir(repo.dir);
      cleanupItems.push(clone);
      const home2 = await loginHome();

      const second = await runKh(["register", "--yes"], { cwd: clone.dir, khHome: home2.dir });
      expect(second.code).toBe(0);

      const config = await readRepoConfig(repo.dir);
      const project = server.api.store.getProject(config!.projectId)!;
      expect(project.locations).toHaveLength(2);
      expect(project.locations.map((l) => l.path).sort()).toEqual([repo.dir, clone.dir].sort());
    });
  });

  it("--bind 与 --new 互斥，同时给出时是用法错误", async () => {
    const repo = await tempRepo();
    const home = await loginHome();
    const result = await runKh(["register", "--bind", "abcd1234", "--new", "--yes"], { cwd: repo.dir, khHome: home.dir });
    expect(result.code).toBe(2);
    expect(server.api.store.listProjects()).toHaveLength(0);
  });

  it("未登录，退出码 3", async () => {
    const repo = await tempRepo();
    const home = await tempHome();
    const result = await runKh(["register", "--new", "--yes"], { cwd: repo.dir, khHome: home.dir });
    expect(result.code).toBe(3);
  });

  describe("失败后重新执行", () => {
    it("建项目成功后登记位置失败：重新执行时建议绑定刚建的项目，不会重复建项目", async () => {
      const repo = await tempRepo();
      const home = await loginHome();

      const spy = vi.spyOn(server.api.store, "setLocation").mockRejectedValueOnce(new Error("模拟登记位置失败"));
      const first = await runKh(["register", "--new", "--yes"], { cwd: repo.dir, khHome: home.dir });
      expect(first.code).toBe(1);
      expect(spy).toHaveBeenCalledTimes(1);
      await expect(fs.stat(path.join(repo.dir, ".kanban-hub"))).rejects.toThrow();
      expect(server.api.store.listProjects()).toHaveLength(1);

      const second = await runKh(["register", "--yes"], { cwd: repo.dir, khHome: home.dir });
      expect(second.code).toBe(0);
      expect(second.stdout).toContain("绑定到已有项目");
      expect(server.api.store.listProjects()).toHaveLength(1);

      const config = await readRepoConfig(repo.dir);
      expect(config?.projectId).toBe(server.api.store.listProjects()[0]!.id);
    });
  });
});
