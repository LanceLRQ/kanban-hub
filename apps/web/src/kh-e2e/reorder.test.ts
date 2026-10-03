/**
 * kh task reorder / kh container reorder 的端到端测试：进程内测试服务端驱动 cli 的 main()。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "@kanban-hub/core/schema";
import { startTestServer, type TestServer } from "../server/api/test-server";
import { cleanupAll, loginFixture, makeTempKhHome, makeTempRepo, registerProjectFixture, runKh, type TempDir, type TempRepo } from "./harness";

let server: TestServer;
let home: TempDir;
let repo: TempRepo;

beforeEach(async () => {
  server = await startTestServer();
  home = await makeTempKhHome();
  repo = await makeTempRepo();
});

afterEach(async () => {
  await cleanupAll(home, repo);
  await server.close();
});

async function setup(): Promise<{ projectId: string }> {
  await loginFixture(server, repo, home);
  const { projectId } = await registerProjectFixture(server, repo, home, { name: "示例项目" });
  const admin = server.api.store.auth.listUsers().find((u) => u.role === "admin")!;
  const actor: Actor = { userId: admin.id, machineId: null, via: "web", agent: null };
  for (const code of ["M2", "M3", "F1"]) {
    await server.api.store.createContainer(projectId, { kind: code === "F1" ? "feature" : "phase", code, title: `容器${code}` }, actor);
  }
  return { projectId };
}

const kh = (args: string[]) => runKh(args, { cwd: repo.dir, khHome: home.dir });

async function addTask(title: string): Promise<string> {
  const result = await kh(["task", "add", "M2", title, "--code", title]);
  if (result.code !== 0) throw new Error(`task add 失败：${result.stderr}`);
  return /#([0-9a-z]{4,10})/.exec(result.stdout)![1]!;
}

function taskTitles(projectId: string): string[] {
  const board = server.api.store.getBoard(projectId)!;
  const m2 = board.containers.find((c) => c.code === "M2")!;
  return board.tasks
    .filter((t) => t.containerId === m2.id)
    .sort((a, b) => a.order - b.order)
    .map((t) => t.title);
}

describe("kh task reorder", () => {
  it("重排后 kh status 里的顺序正确，输出新顺序，时间线新增一条事件", async () => {
    const { projectId } = await setup();
    const a = await addTask("T1");
    const b = await addTask("T2");
    const c = await addTask("T3");

    const result = await kh(["task", "reorder", "M2", `#${c}`, `#${a}`]);
    expect(result.code).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines[0]).toBe("已重排 M2 的任务顺序：");
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain(`#${c}`);
    expect(lines[3]).toContain(`#${b}`);
    expect(taskTitles(projectId)).toEqual(["T3", "T1", "T2"]);

    const status = await kh(["status"]);
    expect(status.stdout.indexOf("T3")).toBeLessThan(status.stdout.indexOf("T1"));
    expect(status.stdout.indexOf("T1")).toBeLessThan(status.stdout.indexOf("T2"));

    const events = await server.api.store.listEvents({ projectId, limit: 20 });
    expect(events.filter((e) => e.type === "board.reordered")).toHaveLength(1);
  });

  it("任务参数可以写本容器内的裸编号，也可以和 #短ID 混用", async () => {
    const { projectId } = await setup();
    await addTask("T1");
    const b = await addTask("T2");
    await addTask("T3");

    const result = await kh(["task", "reorder", "M2", "T3", `#${b}`]);
    expect(result.code).toBe(0);
    expect(taskTitles(projectId)).toEqual(["T3", "T2", "T1"]);

    const missing = await kh(["task", "reorder", "M2", "T9"]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("里没有编号为 T9 的任务");
  });

  it("重排不更新最近上报时间", async () => {
    const { projectId } = await setup();
    const a = await addTask("T1");
    const b = await addTask("T2");
    const reportFile = path.join(home.dir, "cache", "reports", `${projectId}.json`);
    const before = await fs.readFile(reportFile, "utf8");
    expect((await kh(["task", "reorder", "M2", `#${b}`, `#${a}`])).code).toBe(0);
    expect((await kh(["container", "reorder", "F1", "M3"])).code).toBe(0);
    expect(await fs.readFile(reportFile, "utf8")).toBe(before);
  });

  it("顺序没变化时输出“顺序未变化”，不新增事件", async () => {
    const { projectId } = await setup();
    const a = await addTask("T1");
    await addTask("T2");

    const result = await kh(["task", "reorder", "M2", `#${a}`]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("顺序未变化");
    const events = await server.api.store.listEvents({ projectId, limit: 20 });
    expect(events.filter((e) => e.type === "board.reordered")).toHaveLength(0);
  });

  it("任务不属于该容器、参数重复：退出码 2，顺序不变", async () => {
    const { projectId } = await setup();
    await addTask("T1");
    const b = await addTask("T2");
    const misc = await kh(["task", "add", "misc", "杂项任务"]);
    const m = /#([0-9a-z]{4,10})/.exec(misc.stdout)![1]!;

    const wrong = await kh(["task", "reorder", "M2", `#${b}`, `#${m}`]);
    expect(wrong.code).toBe(2);
    const dup = await kh(["task", "reorder", "M2", `#${b}`, `#${b}`]);
    expect(dup.code).toBe(2);
    expect(taskTitles(projectId)).toEqual(["T1", "T2"]);
  });
});

describe("kh container reorder", () => {
  it("重排后 kh status 里容器顺序正确，并新增一条事件", async () => {
    const { projectId } = await setup();
    const result = await kh(["container", "reorder", "F1", "M3"]);
    expect(result.code).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines[0]).toBe("已调整容器顺序：");
    expect(lines[1]).toContain("F1");
    expect(lines[2]).toContain("M3");
    expect(lines[3]).toContain("M2");

    const status = await kh(["status"]);
    const idx = (s: string) => status.stdout.indexOf(`容器${s}`);
    expect(idx("F1")).toBeLessThan(idx("M3"));
    expect(idx("M3")).toBeLessThan(idx("M2"));

    const events = await server.api.store.listEvents({ projectId, limit: 20 });
    expect(events.filter((e) => e.type === "board.reordered")).toHaveLength(1);
  });

  it("含 misc：退出码 2", async () => {
    await setup();
    expect((await kh(["container", "reorder", "M2", "misc"])).code).toBe(2);
  });
});
