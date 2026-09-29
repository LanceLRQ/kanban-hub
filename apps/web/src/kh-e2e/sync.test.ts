/**
 * kh sync 的端到端测试：用进程内测试服务端（真实路由处理函数 + 临时存储）驱动 cli 的 main()。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readLastReport } from "../../../../packages/cli/src/report-log";
import { readRepoConfig, writeRepoConfig } from "../../../../packages/cli/src/repo/config";
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

describe("kh sync", () => {
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

  /** 登录、建项目、登记本机位置，并把仓库配置的同步范围改成调用方需要的写法 */
  async function setupProject(
    repo: TempRepo,
    opts: { include?: string[]; exclude?: string[]; maxFileSize?: string } = {},
  ): Promise<{ home: TempDir; projectId: string; machineId: string }> {
    const home = await tempHome();
    await loginFixture(server, repo, home);
    const { projectId, machineId } = await registerProjectFixture(server, repo, home);
    await writeRepoConfig(repo.dir, {
      projectId,
      sync: { include: opts.include ?? ["docs/**"], exclude: opts.exclude ?? [], maxFileSize: opts.maxFileSize ?? "5MB" },
      pull: { auto: true },
    });
    return { home, projectId, machineId };
  }

  it("首次同步与增量：快照逐字节一致，第二次同步没有变化也不再上传内容，也不产生新事件", async () => {
    const repo = await tempRepo();
    await fs.mkdir(path.join(repo.dir, "docs"), { recursive: true });
    await fs.writeFile(path.join(repo.dir, "docs", "a.md"), "# hello\n");
    const { home, projectId, machineId } = await setupProject(repo);

    const first = await runKh(["sync"], { cwd: repo.dir, khHome: home.dir });
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("新增 1");

    const bytes = await server.api.store.readSnapshotFile(projectId, machineId, "docs/a.md");
    expect(Buffer.from(bytes ?? []).toString("utf8")).toBe("# hello\n");

    const putSpy = vi.spyOn(server.api.store, "putSyncBlob");
    const second = await runKh(["sync"], { cwd: repo.dir, khHome: home.dir });
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("没有变化");
    expect(putSpy).not.toHaveBeenCalled();

    // kh sync 对仓库只读：本机文件内容不会被改动
    expect(await fs.readFile(path.join(repo.dir, "docs", "a.md"), "utf8")).toBe("# hello\n");

    const events = await server.api.store.listEvents({ projectId, limit: 20 });
    expect(events.filter((e) => e.type === "docs.synced")).toHaveLength(1);
  });

  it("修改、删除、新增之后同步，计数正确", async () => {
    const repo = await tempRepo();
    await fs.mkdir(path.join(repo.dir, "docs"), { recursive: true });
    await fs.writeFile(path.join(repo.dir, "docs", "a.md"), "a");
    await fs.writeFile(path.join(repo.dir, "docs", "b.md"), "b");
    const { home, projectId, machineId } = await setupProject(repo);

    const first = await runKh(["sync"], { cwd: repo.dir, khHome: home.dir });
    expect(first.code).toBe(0);

    await fs.writeFile(path.join(repo.dir, "docs", "a.md"), "a2");
    await fs.rm(path.join(repo.dir, "docs", "b.md"));
    await fs.writeFile(path.join(repo.dir, "docs", "c.md"), "c");

    const second = await runKh(["sync"], { cwd: repo.dir, khHome: home.dir });
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("新增 1");
    expect(second.stdout).toContain("修改 1");
    expect(second.stdout).toContain("删除 1");

    const manifest = server.api.store.getSnapshotManifest(projectId, machineId);
    const paths = manifest?.files.map((f) => f.path).sort();
    expect(paths).toEqual(["docs/a.md", "docs/c.md"]);
  });

  it("超过大小限制的文件与指向仓库外的软链接都会被跳过，并在输出里列出", async () => {
    const repo = await tempRepo();
    await fs.mkdir(path.join(repo.dir, "docs"), { recursive: true });
    await fs.writeFile(path.join(repo.dir, "docs", "big.md"), "x".repeat(200));

    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "kh-e2e-outside-"));
    cleanupItems.push({ dir: outsideDir, cleanup: () => fs.rm(outsideDir, { recursive: true, force: true }) });
    const outsideFile = path.join(outsideDir, "external.md");
    await fs.writeFile(outsideFile, "external");
    await fs.symlink(outsideFile, path.join(repo.dir, "docs", "link.md"));

    const { home, projectId, machineId } = await setupProject(repo, { maxFileSize: "10" });

    const result = await runKh(["sync"], { cwd: repo.dir, khHome: home.dir });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("docs/big.md");
    expect(result.stdout).toContain("docs/link.md");

    const project = server.api.store.getProject(projectId)!;
    const location = project.locations.find((l) => l.machineId === machineId)!;
    expect(location.skippedFiles.map((f) => f.path)).toEqual(["docs/big.md"]);
  });

  it("仓库配置的同步范围写法不合法时，退出码 2", async () => {
    const repo = await tempRepo();
    const { home } = await setupProject(repo);
    const config = await readRepoConfig(repo.dir);
    await writeRepoConfig(repo.dir, {
      projectId: config!.projectId,
      sync: { include: ["../x"], exclude: [], maxFileSize: "5MB" },
      pull: { auto: true },
    });

    const result = await runKh(["sync"], { cwd: repo.dir, khHome: home.dir });
    expect(result.code).toBe(2);
  });

  it("暂存已过期（服务端上手动删除）时自动重试并成功", async () => {
    const repo = await tempRepo();
    await fs.mkdir(path.join(repo.dir, "docs"), { recursive: true });
    await fs.writeFile(path.join(repo.dir, "docs", "a.md"), "a");
    const { home, projectId, machineId } = await setupProject(repo);

    let sabotaged = false;
    const wrappedFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      const url = typeof input === "string" ? input : input.toString();
      if (!sabotaged && url.includes("/sync/manifest") && response.ok) {
        sabotaged = true;
        const clone = response.clone();
        const body = (await clone.json()) as { syncId: string };
        await fs.rm(path.join(server.api.store.dataDirectory, ".staging", body.syncId), { recursive: true, force: true });
      }
      return response;
    };

    const result = await runKh(["sync"], { cwd: repo.dir, khHome: home.dir, fetch: wrappedFetch });
    expect(result.code).toBe(0);
    expect(sabotaged).toBe(true);

    const bytes = await server.api.store.readSnapshotFile(projectId, machineId, "docs/a.md");
    expect(Buffer.from(bytes ?? []).toString("utf8")).toBe("a");
  });

  it(
    "同步锁被占用时，等待后仍占用，退出码 1",
    async () => {
      const repo = await tempRepo();
      const { home, projectId } = await setupProject(repo);
      const lockFile = path.join(home.dir, "cache", projectId, "lock");
      await fs.mkdir(path.dirname(lockFile), { recursive: true });
      await fs.writeFile(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));

      // 锁被占用时会先等待（最多 5 秒）才报错，这里接受这个等待，用更长的测试超时
      const result = await runKh(["sync"], { cwd: repo.dir, khHome: home.dir });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("正在进行");
    },
    10_000,
  );

  it("--quiet：成功时不输出内容", async () => {
    const repo = await tempRepo();
    await fs.mkdir(path.join(repo.dir, "docs"), { recursive: true });
    await fs.writeFile(path.join(repo.dir, "docs", "a.md"), "a");
    const { home } = await setupProject(repo);

    const result = await runKh(["sync", "--quiet"], { cwd: repo.dir, khHome: home.dir });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("kh sync 成功之后，不算一次上报（上报时间不变）", async () => {
    const repo = await tempRepo();
    await fs.mkdir(path.join(repo.dir, "docs"), { recursive: true });
    await fs.writeFile(path.join(repo.dir, "docs", "a.md"), "a");
    const { home, projectId } = await setupProject(repo);

    const before = await readLastReport(home.dir, projectId);
    expect(before).toBeNull();

    const result = await runKh(["sync"], { cwd: repo.dir, khHome: home.dir });
    expect(result.code).toBe(0);

    const after = await readLastReport(home.dir, projectId);
    expect(after).toBeNull();
  });
});
