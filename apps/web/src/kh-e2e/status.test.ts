/**
 * kh status 的端到端测试：进程内测试服务端 + 临时仓库/KH_HOME 驱动 cli 的 main()。
 * register 是任务 6 的范围，这里直接用 store 建项目、登记位置，再用 writeRepoConfig
 * 写出仓库配置（控制者裁决：三个文件各写一份，波次结束后再决定是否收拢，见 wave4-common.md）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "@kanban-hub/core/schema";
import { readMachineConfig } from "../../../../packages/cli/src/config/home";
import { writeRepoConfig } from "../../../../packages/cli/src/repo/config";
import { startTestServer, type TestServer } from "../server/api/test-server";
import { cleanupAll, makeTempKhHome, makeTempRepo, runKh, type TempDir, type TempRepo } from "./harness";

describe("kh status", () => {
  let server: TestServer;
  let repo: TempRepo;
  let home: TempDir;

  beforeEach(async () => {
    server = await startTestServer();
    repo = await makeTempRepo();
    home = await makeTempKhHome();
  });

  afterEach(async () => {
    await cleanupAll(repo, home);
    await server.close();
  });

  function adminActor(): Actor {
    const admin = server.api.store.auth.listUsers().find((u) => u.role === "admin");
    if (!admin) throw new Error("测试前置条件失败：没有管理员账号");
    return { userId: admin.id, machineId: null, via: "web", agent: null };
  }

  /** 登录 + 建项目 + 登记本机位置 + 写仓库配置：status 的公共前置条件 */
  async function registerProject(): Promise<{ projectId: string; projectName: string }> {
    const { code } = server.issuePairingCode();
    const loginResult = await runKh(["login", "--server", server.url, "--code", code, "--name", "测试机"], {
      cwd: repo.dir,
      khHome: home.dir,
    });
    if (loginResult.code !== 0) throw new Error(`测试前置条件失败：登录失败 ${loginResult.stderr}`);
    const cfg = await readMachineConfig(home.dir);
    const machineId = cfg?.machineId;
    if (machineId === undefined) throw new Error("测试前置条件失败：登录后读不到 machineId");

    const actor = adminActor();
    const { project } = await server.api.store.createProject({ name: "示例项目", focus: "打磨发布前的细节" }, actor);
    await server.api.store.setLocation(project.id, machineId, { path: repo.dir }, actor);

    await writeRepoConfig(repo.dir, {
      projectId: project.id,
      sync: { include: ["docs/**"], exclude: [], maxFileSize: "5MB" },
      pull: { auto: true },
    });

    return { projectId: project.id, projectName: project.name };
  }

  it("注册后执行 status，退出码 0，输出里有项目名", async () => {
    const { projectName } = await registerProject();
    const result = await runKh(["status"], { cwd: repo.dir, khHome: home.dir });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(projectName);
  });

  it("--json 能解析，包含全部任务", async () => {
    const { projectId } = await registerProject();
    const actor = adminActor();
    const container = await server.api.store.createContainer(projectId, { kind: "phase", title: "阶段一", code: "M1" }, actor);
    await server.api.store.createTask(projectId, { containerId: container.id, title: "已完成任务", status: "done" }, actor);
    await server.api.store.createTask(projectId, { containerId: container.id, title: "进行中任务", status: "in_progress" }, actor);

    const result = await runKh(["status", "--json"], { cwd: repo.dir, khHome: home.dir });
    expect(result.code).toBe(0);

    const json = JSON.parse(result.stdout) as { containers: { tasks: { title: string }[] }[] };
    const titles = json.containers.flatMap((c) => c.tasks.map((t) => t.title));
    // --json 包含全部任务，即使已完成的任务在文本输出里会被折叠成数量
    expect(titles).toEqual(expect.arrayContaining(["已完成任务", "进行中任务"]));
  });

  it("不在已注册的仓库里，退出码 2", async () => {
    const bareRepo = await makeTempRepo();
    try {
      const result = await runKh(["status"], { cwd: bareRepo.dir, khHome: home.dir });
      expect(result.code).toBe(2);
    } finally {
      await bareRepo.cleanup();
    }
  });

  it("未登录，退出码 3", async () => {
    await writeRepoConfig(repo.dir, {
      projectId: "abcdefghij",
      sync: { include: [], exclude: [], maxFileSize: "5MB" },
      pull: { auto: true },
    });
    const result = await runKh(["status"], { cwd: repo.dir, khHome: home.dir });
    expect(result.code).toBe(3);
  });

  it("配置文件里的项目 ID 在服务端不存在，退出码 5，并提示检查 .kanban-hub/config.yaml", async () => {
    const { code } = server.issuePairingCode();
    const loginResult = await runKh(["login", "--server", server.url, "--code", code, "--name", "测试机"], {
      cwd: repo.dir,
      khHome: home.dir,
    });
    expect(loginResult.code).toBe(0);

    await writeRepoConfig(repo.dir, {
      projectId: "zzzzzzzzzz",
      sync: { include: [], exclude: [], maxFileSize: "5MB" },
      pull: { auto: true },
    });

    const result = await runKh(["status"], { cwd: repo.dir, khHome: home.dir });
    expect(result.code).toBe(5);
    expect(result.stderr).toContain(".kanban-hub/config.yaml");
  });

  it("不写文件：执行后本地 cache/ 里没有上报记录", async () => {
    const { projectId } = await registerProject();
    const result = await runKh(["status"], { cwd: repo.dir, khHome: home.dir });
    expect(result.code).toBe(0);
    await expect(fs.stat(path.join(home.dir, "cache", "reports", `${projectId}.json`))).rejects.toThrow();
  });

  it("令牌不出现在 stdout/stderr 里", async () => {
    await registerProject();
    const token = (await fs.readFile(path.join(home.dir, "credentials"), "utf8")).trim();
    const result = await runKh(["status"], { cwd: repo.dir, khHome: home.dir });
    expect(result.stdout).not.toContain(token);
    expect(result.stderr).not.toContain(token);
  });
});
