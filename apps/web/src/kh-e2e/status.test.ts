/**
 * kh status 的端到端测试：进程内测试服务端 + 临时仓库/KH_HOME 驱动 cli 的 main()。
 * register 命令自己的行为在 register.test.ts 单独测试，这里用 harness 的
 * loginFixture / registerProjectFixture 直接搭好前置条件。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "@kanban-hub/core/schema";
import { writeRepoConfig } from "../../../../packages/cli/src/repo/config";
import { startTestServer, type TestServer } from "../server/api/test-server";
import { cleanupAll, loginFixture, makeTempKhHome, makeTempRepo, registerProjectFixture, runKh, type TempDir, type TempRepo } from "./harness";

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

  /** 登录 + 建项目 + 登记本机位置 + 写仓库配置（含建议的同步范围）：status 的公共前置条件 */
  async function registerProject(): Promise<{ projectId: string; projectName: string }> {
    await loginFixture(server, repo, home);
    const { projectId } = await registerProjectFixture(server, repo, home, {
      name: "示例项目",
      focus: "打磨发布前的细节",
    });
    await writeRepoConfig(repo.dir, {
      projectId,
      sync: { include: ["docs/**"], exclude: [], maxFileSize: "5MB" },
      pull: { auto: true },
    });
    const projectName = server.api.store.getProject(projectId)?.name ?? "示例项目";
    return { projectId, projectName };
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
