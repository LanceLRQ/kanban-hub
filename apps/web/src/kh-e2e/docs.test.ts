/**
 * kh docs ls / kh docs cat 的端到端测试：用进程内测试服务端驱动 cli 的 main()，模拟两台机器
 * 同步同一个项目，验证第二台机器能只读地浏览第一台机器同步过来的文档。
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Actor } from "@kanban-hub/core/schema";
import { SYNC_DEFAULT_MAX_FILE_SIZE } from "@kanban-hub/core/sync";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readMachineConfig } from "../../../../packages/cli/src/config/home";
import { writeRepoConfig } from "../../../../packages/cli/src/repo/config";
import { startTestServer, type TestServer } from "../server/api/test-server";
import {
  cleanupAll,
  loginFixture,
  makeTempKhHome,
  makeTempRepo,
  registerProjectFixture,
  runKh,
  type TempDir,
  type TempRepo,
} from "./harness";

describe("kh docs", () => {
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

  async function tempRepo(): Promise<TempRepo> {
    const repo = await makeTempRepo();
    cleanupItems.push(repo);
    return repo;
  }

  async function tempHome(): Promise<TempDir> {
    const home = await makeTempKhHome();
    cleanupItems.push(home);
    return home;
  }

  /** 让另一台已登录的机器加入同一个项目（不新建项目），只登记位置、写出仓库配置 */
  async function joinProject(khHomeDir: string, repoDir: string, projectId: string): Promise<string> {
    const cfg = await readMachineConfig(khHomeDir);
    const machineId = cfg?.machineId;
    if (!machineId) throw new Error("测试前置条件失败：还没有登录");
    const admin = server.api.store.auth.listUsers().find((u) => u.role === "admin");
    if (!admin) throw new Error("测试前置条件失败：找不到管理员账号");
    const actor: Actor = { userId: admin.id, machineId: null, via: "web", agent: null };
    await server.api.store.setLocation(projectId, machineId, { path: repoDir }, actor);
    await writeRepoConfig(repoDir, {
      projectId,
      sync: { include: [], exclude: [], maxFileSize: SYNC_DEFAULT_MAX_FILE_SIZE },
      pull: { auto: true },
    });
    return machineId;
  }

  it("A 同步后，B 能 ls/cat 看到 A 的文件；--from 用名称和 ID 前缀都能选中；glob 过滤生效", async () => {
    const repoA = await tempRepo();
    await fs.mkdir(path.join(repoA.dir, "docs"), { recursive: true });
    await fs.writeFile(path.join(repoA.dir, "docs", "a.md"), "# A\n");
    await fs.writeFile(path.join(repoA.dir, "docs", "b.txt"), "plain text");

    const homeA = await tempHome();
    await loginFixture(server, repoA, homeA, { name: "机器A" });
    const { projectId, machineId: machineIdA } = await registerProjectFixture(server, repoA, homeA);
    await writeRepoConfig(repoA.dir, {
      projectId,
      sync: { include: ["docs/**"], exclude: [], maxFileSize: "5MB" },
      pull: { auto: true },
    });
    const syncA = await runKh(["sync"], { cwd: repoA.dir, khHome: homeA.dir });
    expect(syncA.code).toBe(0);

    const repoB = await tempRepo();
    const homeB = await tempHome();
    await loginFixture(server, repoB, homeB, { name: "机器B" });
    await joinProject(homeB.dir, repoB.dir, projectId);

    const ls = await runKh(["docs", "ls"], { cwd: repoB.dir, khHome: homeB.dir });
    expect(ls.code).toBe(0);
    expect(ls.stdout).toContain("docs/a.md");
    expect(ls.stdout).toContain("docs/b.txt");
    expect(ls.stdout).toContain("机器A");

    const lsGlob = await runKh(["docs", "ls", "docs/*.md"], { cwd: repoB.dir, khHome: homeB.dir });
    expect(lsGlob.code).toBe(0);
    expect(lsGlob.stdout).toContain("docs/a.md");
    expect(lsGlob.stdout).not.toContain("docs/b.txt");

    const lsFromName = await runKh(["docs", "ls", "--from", "机器A"], { cwd: repoB.dir, khHome: homeB.dir });
    expect(lsFromName.code).toBe(0);
    expect(lsFromName.stdout).toContain("docs/a.md");

    const lsFromId = await runKh(["docs", "ls", "--from", machineIdA.slice(0, 4)], { cwd: repoB.dir, khHome: homeB.dir });
    expect(lsFromId.code).toBe(0);
    expect(lsFromId.stdout).toContain("docs/a.md");

    const cat = await runKh(["docs", "cat", "docs/a.md"], { cwd: repoB.dir, khHome: homeB.dir });
    expect(cat.code).toBe(0);
    expect(cat.stdout).toBe("# A\n");

    const catFrom = await runKh(["docs", "cat", "--from", "机器A", "docs/b.txt"], { cwd: repoB.dir, khHome: homeB.dir });
    expect(catFrom.code).toBe(0);
    expect(catFrom.stdout).toBe("plain text");
  });

  it("文件不在快照中时，kh docs cat 报数据错误（退出码 5）", async () => {
    const repoA = await tempRepo();
    await fs.mkdir(path.join(repoA.dir, "docs"), { recursive: true });
    await fs.writeFile(path.join(repoA.dir, "docs", "a.md"), "# A\n");
    const homeA = await tempHome();
    await loginFixture(server, repoA, homeA, { name: "机器A" });
    const { projectId } = await registerProjectFixture(server, repoA, homeA);
    await writeRepoConfig(repoA.dir, {
      projectId,
      sync: { include: ["docs/**"], exclude: [], maxFileSize: "5MB" },
      pull: { auto: true },
    });
    await runKh(["sync"], { cwd: repoA.dir, khHome: homeA.dir });

    const repoB = await tempRepo();
    const homeB = await tempHome();
    await loginFixture(server, repoB, homeB, { name: "机器B" });
    await joinProject(homeB.dir, repoB.dir, projectId);

    const result = await runKh(["docs", "cat", "docs/not-there.md"], { cwd: repoB.dir, khHome: homeB.dir });
    expect(result.code).toBe(5);
  });

  it("其他机器都还没有同步过时，kh docs ls 返回退出码 5", async () => {
    const repo = await tempRepo();
    const home = await tempHome();
    await loginFixture(server, repo, home);
    await registerProjectFixture(server, repo, home);

    const result = await runKh(["docs", "ls"], { cwd: repo.dir, khHome: home.dir });
    expect(result.code).toBe(5);
  });

  it("只有本机自己同步过、其他机器都没有时，同样返回退出码 5（本机不能算“其他机器”）", async () => {
    const repo = await tempRepo();
    await fs.mkdir(path.join(repo.dir, "docs"), { recursive: true });
    await fs.writeFile(path.join(repo.dir, "docs", "a.md"), "# A\n");
    const home = await tempHome();
    await loginFixture(server, repo, home);
    const { projectId } = await registerProjectFixture(server, repo, home);
    await writeRepoConfig(repo.dir, {
      projectId,
      sync: { include: ["docs/**"], exclude: [], maxFileSize: "5MB" },
      pull: { auto: true },
    });
    const syncResult = await runKh(["sync"], { cwd: repo.dir, khHome: home.dir });
    expect(syncResult.code).toBe(0);

    const result = await runKh(["docs", "ls"], { cwd: repo.dir, khHome: home.dir });
    expect(result.code).toBe(5);
  });

  /** 建两台机器：A 写好文件并同步，B 登录并加入同一个项目；返回两边的目录和 A 的机器 ID */
  async function setupTwoMachines(files: Record<string, Buffer | string>): Promise<{
    repoA: TempRepo;
    repoB: TempRepo;
    homeB: TempDir;
    projectId: string;
  }> {
    const repoA = await tempRepo();
    await fs.mkdir(path.join(repoA.dir, "docs"), { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      await fs.writeFile(path.join(repoA.dir, rel), content);
    }
    const homeA = await tempHome();
    await loginFixture(server, repoA, homeA, { name: "机器A" });
    const { projectId } = await registerProjectFixture(server, repoA, homeA);
    await writeRepoConfig(repoA.dir, {
      projectId,
      sync: { include: ["docs/**"], exclude: [], maxFileSize: "5MB" },
      pull: { auto: true },
    });
    const syncA = await runKh(["sync"], { cwd: repoA.dir, khHome: homeA.dir });
    expect(syncA.code).toBe(0);

    const repoB = await tempRepo();
    const homeB = await tempHome();
    await loginFixture(server, repoB, homeB, { name: "机器B" });
    await joinProject(homeB.dir, repoB.dir, projectId);

    return { repoA, repoB, homeB, projectId };
  }

  it("二进制内容（含 NUL 字节）：kh docs cat 报数据错误（退出码 5），提示到网页查看", async () => {
    const binary = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x41]);
    const { repoB, homeB } = await setupTwoMachines({ "docs/bin.dat": binary });

    const result = await runKh(["docs", "cat", "docs/bin.dat"], { cwd: repoB.dir, khHome: homeB.dir });
    expect(result.code).toBe(5);
    expect(result.stderr).toContain("二进制文件");
  });

  it("UTF-8 中文内容：kh docs cat 输出与原字节一致", async () => {
    const content = "# 设计笔记\n这里有中文、标点，还有一个 emoji：🎉\n";
    const { repoB, homeB } = await setupTwoMachines({ "docs/zh.md": content });

    const result = await runKh(["docs", "cat", "docs/zh.md"], { cwd: repoB.dir, khHome: homeB.dir });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(content);
  });

  it("下载内容与响应头 X-KH-Sha256 不一致时，kh docs cat 报错退出码 1", async () => {
    const { repoB, homeB } = await setupTwoMachines({ "docs/a.md": "# A\n" });

    const wrappedFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      const url = typeof input === "string" ? input : input.toString();
      if (!url.includes("/snapshots/") || !url.includes("/files/")) return response;
      const buffer = await response.arrayBuffer();
      const headers = new Headers(response.headers);
      headers.set("X-KH-Sha256", "0".repeat(64));
      return new Response(buffer, { status: response.status, statusText: response.statusText, headers });
    };

    const result = await runKh(["docs", "cat", "docs/a.md"], { cwd: repoB.dir, khHome: homeB.dir, fetch: wrappedFetch });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("hash 与响应头不一致");
  });
});
