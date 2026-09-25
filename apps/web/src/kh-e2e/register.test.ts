/**
 * kh register 的端到端测试：用进程内测试服务端（真实路由处理函数 + 临时存储）驱动 cli 的 main()。
 * 每个用例独立起一个 TestServer，避免不同用例之间的项目数据互相干扰。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readRepoConfig, writeRepoConfig } from "../../../../packages/cli/src/repo/config";
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

    it("--name 超过 100 个字符时，--dry-run 就返回 2：名称校验排在打印计划之前，不建项目也不写文件", async () => {
      const repo = await tempRepo();
      const home = await loginHome();
      const before = server.api.store.listProjects().length;

      const result = await runKh(["register", "--new", "--dry-run", "--name", "a".repeat(101)], {
        cwd: repo.dir,
        khHome: home.dir,
      });
      expect(result.code).toBe(2);
      expect(server.api.store.listProjects().length).toBe(before);
      await expect(fs.stat(path.join(repo.dir, ".kanban-hub"))).rejects.toThrow();
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
      // 提示重新执行时改用 --bind 绑定刚建好的项目，避免重复新建
      const project = server.api.store.listProjects()[0]!;
      expect(first.stderr).toContain(project.id);
      expect(first.stderr).toContain("--bind");
      expect(first.stderr).toContain("避免重复新建");

      const second = await runKh(["register", "--yes"], { cwd: repo.dir, khHome: home.dir });
      expect(second.code).toBe(0);
      expect(second.stdout).toContain("绑定到已有项目");
      expect(server.api.store.listProjects()).toHaveLength(1);

      const config = await readRepoConfig(repo.dir);
      expect(config?.projectId).toBe(server.api.store.listProjects()[0]!.id);
    });
  });

  describe("默认 KH_HOME 撞仓库路径", () => {
    it("主目录下的非 git 子目录能正常注册", async () => {
      const fakeHome = await makeRealTempDir("kh-e2e-fakehome-");
      cleanupItems.push({ dir: fakeHome, cleanup: () => fs.rm(fakeHome, { recursive: true, force: true }) });
      const khHomeDir = path.join(fakeHome, ".kanban-hub");
      const subDir = path.join(fakeHome, "notes", "sub");
      await fs.mkdir(subDir, { recursive: true });

      const { code } = server.issuePairingCode();
      const login = await runKh(["login", "--server", server.url, "--code", code], {
        cwd: subDir,
        khHome: khHomeDir,
        homeDir: fakeHome,
      });
      expect(login.code).toBe(0);

      const result = await runKh(["register", "--new", "--yes"], {
        cwd: subDir,
        khHome: khHomeDir,
        homeDir: fakeHome,
      });
      expect(result.code).toBe(0);
      expect(server.api.store.listProjects()).toHaveLength(1);
    });

    it("在主目录本身执行 register，返回 2，本机配置没有被改动", async () => {
      const fakeHome = await makeRealTempDir("kh-e2e-fakehome-");
      cleanupItems.push({ dir: fakeHome, cleanup: () => fs.rm(fakeHome, { recursive: true, force: true }) });
      const khHomeDir = path.join(fakeHome, ".kanban-hub");

      const { code } = server.issuePairingCode();
      const login = await runKh(["login", "--server", server.url, "--code", code], {
        cwd: fakeHome,
        khHome: khHomeDir,
        homeDir: fakeHome,
      });
      expect(login.code).toBe(0);
      const before = await fs.readFile(path.join(khHomeDir, "config.yaml"), "utf8");

      const result = await runKh(["register", "--new", "--yes"], {
        cwd: fakeHome,
        khHome: khHomeDir,
        homeDir: fakeHome,
      });
      expect(result.code).toBe(2);
      expect(server.api.store.listProjects()).toHaveLength(0);

      const after = await fs.readFile(path.join(khHomeDir, "config.yaml"), "utf8");
      expect(after).toBe(before);
    });
  });

  describe("没有提交的 git 仓库", () => {
    it("能用 --new 注册，指纹准确显示为“还没有提交”而不是“不是 git 仓库”", async () => {
      const repo = await tempRepo({ commits: 0 });
      const home = await loginHome();

      const dryRun = await runKh(["register", "--new", "--dry-run"], { cwd: repo.dir, khHome: home.dir });
      expect(dryRun.code).toBe(0);
      expect(dryRun.stdout).toContain("无（仓库还没有提交）");
      expect(dryRun.stdout).not.toContain("不是 git 仓库");

      const result = await runKh(["register", "--new", "--yes"], { cwd: repo.dir, khHome: home.dir });
      expect(result.code).toBe(0);
      const config = await readRepoConfig(repo.dir);
      const project = server.api.store.getProject(config!.projectId);
      expect(project?.fingerprint).toBeNull();
    });
  });

  describe("链接工作树", () => {
    it("主工作树未注册：在链接工作树里注册，配置写在工作树根，exclude 写进主仓库，两个工作树 git 状态都干净", async () => {
      const mainRepo = await tempRepo();
      const linkedDir = path.join(mainRepo.dir, "..", `${path.basename(mainRepo.dir)}-linked`);
      execFileSync("git", ["worktree", "add", linkedDir, "-b", "kh-e2e-linked", "-q"], {
        cwd: mainRepo.dir,
        encoding: "utf8",
      });
      const linkedRealDir = await fs.realpath(linkedDir);
      const home = await loginHome();

      // worktree 的删除放在这个用例自己的 finally 里同步做完，不放进 cleanupItems：
      // afterEach 的 cleanupAll 是并行执行的，如果和 mainRepo 自己的目录删除撞在一起，
      // `git worktree remove` 需要读取主仓库 .git 下的 worktree 元数据，可能因为主仓库
      // 已经被删掉一半而失败。
      try {
        const result = await runKh(["register", "--new", "--yes"], { cwd: linkedRealDir, khHome: home.dir });
        expect(result.code).toBe(0);

        await expect(fs.stat(path.join(linkedRealDir, ".kanban-hub", "config.yaml"))).resolves.toBeDefined();
        const exclude = await fs.readFile(path.join(mainRepo.dir, ".git", "info", "exclude"), "utf8");
        expect(exclude).toContain("/.kanban-hub/");

        expect(gitStatusPorcelain(mainRepo.dir)).toBe("");
        expect(gitStatusPorcelain(linkedRealDir)).toBe("");
      } finally {
        try {
          execFileSync("git", ["worktree", "remove", "--force", linkedRealDir], { cwd: mainRepo.dir });
        } catch {
          // 忽略：清理失败不影响测试结果，临时目录本身还会被上层的 tempRepo 一起删掉
        }
      }
    });

    it("主工作树已注册：在链接工作树里执行 register --yes 走“已有配置”分支，不会把本机位置改成工作树路径", async () => {
      const mainRepo = await tempRepo();
      const home = await loginHome();
      const first = await runKh(["register", "--new", "--yes"], { cwd: mainRepo.dir, khHome: home.dir });
      expect(first.code).toBe(0);
      const project = server.api.store.listProjects()[0]!;
      expect(project.locations).toHaveLength(1);
      expect(project.locations[0]!.path).toBe(mainRepo.dir);

      const linkedDir = path.join(mainRepo.dir, "..", `${path.basename(mainRepo.dir)}-linked2`);
      execFileSync("git", ["worktree", "add", linkedDir, "-b", "kh-e2e-linked2", "-q"], {
        cwd: mainRepo.dir,
        encoding: "utf8",
      });
      const linkedRealDir = await fs.realpath(linkedDir);

      try {
        const result = await runKh(["register", "--yes"], { cwd: linkedRealDir, khHome: home.dir });
        expect(result.code).toBe(0);
        expect(result.stdout).not.toContain("补登记");

        // 服务端本机位置不变：还是主工作树的路径，没有被链接工作树的路径覆盖
        const updated = server.api.store.getProject(project.id)!;
        expect(updated.locations).toHaveLength(1);
        expect(updated.locations[0]!.path).toBe(mainRepo.dir);

        // 工作树里不写出 .kanban-hub/
        await expect(fs.stat(path.join(linkedRealDir, ".kanban-hub"))).rejects.toThrow();

        expect(gitStatusPorcelain(mainRepo.dir)).toBe("");
        expect(gitStatusPorcelain(linkedRealDir)).toBe("");
      } finally {
        try {
          execFileSync("git", ["worktree", "remove", "--force", linkedRealDir], { cwd: mainRepo.dir });
        } catch {
          // 忽略：清理失败不影响测试结果
        }
      }
    });
  });

  describe("非 git 目录的子目录不会被父目录的配置吞掉", () => {
    it("已注册的非 git 目录的子目录里执行 --new --dry-run：按全新注册处理", async () => {
      const parentRepo = await tempRepo({ git: false });
      const home1 = await loginHome();
      const first = await runKh(["register", "--new", "--yes"], { cwd: parentRepo.dir, khHome: home1.dir });
      expect(first.code).toBe(0);

      const subDir = path.join(parentRepo.dir, "sub");
      await fs.mkdir(subDir, { recursive: true });
      const home2 = await loginHome();
      const result = await runKh(["register", "--new", "--dry-run"], { cwd: subDir, khHome: home2.dir });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("动作：新建项目");
      expect(result.stdout).not.toContain("补登记");
    });
  });

  describe("已有配置但项目在服务端不存在", () => {
    it("退出码 5，提示检查 .kanban-hub/config.yaml", async () => {
      const repo = await tempRepo();
      const home = await loginHome();
      // 模拟“配置文件指向了一个服务端上不存在的项目”（项目已被删除，或者配置来自另一个服务端）
      await writeRepoConfig(repo.dir, {
        projectId: "zzzzzzzzzz",
        sync: { include: [], exclude: [], maxFileSize: "5MB" },
        pull: { auto: true },
      });

      const result = await runKh(["register", "--yes"], { cwd: repo.dir, khHome: home.dir });
      expect(result.code).toBe(5);
      expect(result.stderr).toContain(".kanban-hub/config.yaml");
    });
  });

  describe("已有配置时显式参数冲突", () => {
    it("给了 --new，返回 2，提示先删除配置文件", async () => {
      const repo = await tempRepo();
      const home = await loginHome();
      const first = await runKh(["register", "--new", "--yes"], { cwd: repo.dir, khHome: home.dir });
      expect(first.code).toBe(0);
      const projectId = server.api.store.listProjects()[0]!.id;

      const result = await runKh(["register", "--new", "--yes"], { cwd: repo.dir, khHome: home.dir });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(projectId);
      expect(server.api.store.listProjects()).toHaveLength(1);
    });

    it("给了不一致的 --bind，返回 2", async () => {
      const repoA = await tempRepo();
      const home1 = await loginHome();
      await runKh(["register", "--new", "--yes"], { cwd: repoA.dir, khHome: home1.dir });

      const repoB = await tempRepo();
      const home2 = await loginHome();
      const secondProject = await runKh(["register", "--new", "--yes"], { cwd: repoB.dir, khHome: home2.dir });
      expect(secondProject.code).toBe(0);

      const result = await runKh(["register", "--bind", server.api.store.listProjects()[0]!.id, "--yes"], {
        cwd: repoB.dir,
        khHome: home2.dir,
      });
      expect(result.code).toBe(2);
    });

    it("--include / --name 被忽略时，计划里写明不生效", async () => {
      const repo = await tempRepo();
      const home = await loginHome();
      await runKh(["register", "--new", "--yes"], { cwd: repo.dir, khHome: home.dir });

      // 制造“本机位置需要补登记”的场景：换一台机器登录，位置和已登记的不一样
      const home2 = await loginHome();
      const result = await runKh(
        ["register", "--include", "docs/**", "--name", "改个名字", "--dry-run"],
        { cwd: repo.dir, khHome: home2.dir },
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("--include 不生效");
      expect(result.stdout).toContain("--name 不生效");
    });
  });

  describe("补登记分支", () => {
    it("--dry-run 不写入任何内容，也不发写请求", async () => {
      const repo = await tempRepo();
      const home1 = await loginHome();
      await runKh(["register", "--new", "--yes"], { cwd: repo.dir, khHome: home1.dir });
      const project = server.api.store.listProjects()[0]!;

      const home2 = await loginHome();
      const spy = vi.spyOn(server.api.store, "setLocation");
      const result = await runKh(["register", "--dry-run"], { cwd: repo.dir, khHome: home2.dir });
      expect(result.code).toBe(0);
      expect(spy).not.toHaveBeenCalled();
      expect(server.api.store.getProject(project.id)?.locations).toHaveLength(1);
    });

    it("非交互环境不带 --yes，返回 2", async () => {
      const repo = await tempRepo();
      const home1 = await loginHome();
      await runKh(["register", "--new", "--yes"], { cwd: repo.dir, khHome: home1.dir });

      const home2 = await loginHome();
      const result = await runKh(["register"], { cwd: repo.dir, khHome: home2.dir });
      expect(result.code).toBe(2);
    });
  });
});
