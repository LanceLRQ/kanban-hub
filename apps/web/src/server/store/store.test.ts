import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { KhError } from "@kanban-hub/core/errors";
import type { Actor, Event } from "@kanban-hub/core/schema";
import { DataFileError } from "./fsio";
import { GitRepo } from "./git";
import { Store, type StoreChange } from "./store";

let dir: string;
let opened: Store[];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "kh-store-"));
  opened = [];
});

afterEach(async () => {
  for (const store of opened) await store.close();
  await fs.rm(dir, { recursive: true, force: true });
});

/** 从 start 开始、每调用一次前进 1 秒的时钟，保证每次写操作的时间都不同 */
function clockFrom(start: string): () => Date {
  let tick = 0;
  return () => new Date(Date.parse(start) + 1000 * tick++);
}

async function open(start = "2026-09-23T10:00:00.000Z"): Promise<Store> {
  const store = await Store.open({ dataDir: dir, now: clockFrom(start), commitDebounceMs: 60_000, log: () => {} });
  opened.push(store);
  return store;
}

/** 经 GitRepo 调 git：不受外部 GIT_* 变量和用户全局配置影响 */
async function git(...args: string[]): Promise<string> {
  return (await new GitRepo(dir).run(args)).stdout.trim();
}

/** 第一次调用时建用户；每次调用都建一台新机器，返回来自命令行的操作者 */
async function cliActor(store: Store, machineName = "mac"): Promise<Actor> {
  const user =
    store.auth.listUsers()[0] ?? (await store.auth.createUser({ name: "Alice", role: "admin", passwordHash: "x" }));
  const machine = await store.auth.createMachine({
    name: machineName,
    userId: user.id,
    os: "darwin",
    tokenHash: "a".repeat(64),
  });
  return { userId: user.id, machineId: machine.id, via: "cli", agent: null };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error("预期抛出错误");
}

async function readEventLines(projectId: string, month: string): Promise<Event[]> {
  const text = await fs.readFile(path.join(dir, "projects", projectId, "events", `${month}.jsonl`), "utf8");
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Event);
}

describe("打开数据目录", () => {
  it("空目录：建 git 仓库、.gitignore 和会话密钥，并做初始提交", async () => {
    const store = await open();
    expect(store.listProjects()).toEqual([]);
    expect(await git("log", "--format=%s|%an|%cn")).toBe("初始化数据目录|kanban-hub|kanban-hub");
    expect(await fs.readFile(path.join(dir, ".gitignore"), "utf8")).toContain("/auth/");
    expect(store.auth.sessionSecret().length).toBeGreaterThanOrEqual(32);
    expect(await git("status", "--porcelain")).toBe("");
  });

  it("重新打开后读回项目、看板和事件", async () => {
    const first = await open();
    const actor = await cliActor(first);
    const { project } = await first.createProject({ name: "看板" }, actor);
    const container = await first.createContainer(project.id, { kind: "phase", title: "阶段一", code: "M1" }, actor);
    await first.createTask(project.id, { containerId: container.id, title: "任务", code: "1.1" }, actor);
    await first.close();

    const second = await open();
    expect(second.getProject(project.id)).toEqual(project);
    expect(second.getBoard(project.id)?.tasks.map((t) => t.title)).toEqual(["任务"]);
    expect((await second.listEvents({ projectId: project.id, limit: 10 })).map((e) => e.type)).toEqual([
      "task.created",
      "container.created",
      "project.created",
    ]);
  });

  it("启动时补提交上次未提交的改动", async () => {
    const first = await open();
    const { project } = await first.createProject({ name: "看板" }, await cliActor(first));
    // 模拟进程被强杀：不关闭 first，它的改动还在等待提交
    const second = await open();
    expect(await git("log", "-1", "--format=%s|%an")).toBe("补提交上次未提交的改动|kanban-hub");
    expect(await git("status", "--porcelain")).toBe("");
    expect(second.getProject(project.id)?.name).toBe("看板");
  });

  it("进程在 git 提交途中被强杀、留下 index.lock 时照常打开，并补提交", async () => {
    const first = await open();
    await first.createProject({ name: "看板" }, await cliActor(first));
    await fs.writeFile(path.join(dir, ".git", "index.lock"), "");
    const second = await open();
    expect(await git("log", "-1", "--format=%s")).toBe("补提交上次未提交的改动");
    expect(second.listProjects()).toHaveLength(1);
  });

  it("没有 project.yaml 的项目目录（新建到一半）加载时跳过", async () => {
    await fs.mkdir(path.join(dir, "projects", "zzzzzzzzzz"), { recursive: true });
    await fs.writeFile(path.join(dir, "projects", "zzzzzzzzzz", "board.yaml"), "containers: []\ntasks: []\n");
    const store = await open();
    expect(store.listProjects()).toEqual([]);
  });

  it("数据文件有问题时拒绝打开，并指出文件和行号", async () => {
    const first = await open();
    const { project } = await first.createProject({ name: "看板" }, await cliActor(first));
    await first.close();
    const boardFile = path.join(dir, "projects", project.id, "board.yaml");
    await fs.writeFile(boardFile, "containers: []\ntasks: []\n");
    const err = await rejection(Store.open({ dataDir: dir, now: clockFrom("2026-09-23T10:00:00.000Z"), log: () => {} }));
    expect(err).toBeInstanceOf(DataFileError);
    expect(err).toMatchObject({ file: boardFile, line: 1 });
    expect((err as DataFileError).reason).toContain("杂项容器");
  });
});

describe("写操作", () => {
  it("新建项目：写 project.yaml、带杂项容器的 board.yaml 和事件，并通知订阅者", async () => {
    const store = await open();
    const actor = await cliActor(store);
    const changes: StoreChange[] = [];
    store.subscribe((change) => changes.push(change));
    const { project, board } = await store.createProject({ name: "看板" }, actor);
    expect(board.containers.map((c) => c.kind)).toEqual(["misc"]);
    expect(await fs.readFile(path.join(dir, "projects", project.id, "project.yaml"), "utf8")).toContain("name: 看板");
    const events = await readEventLines(project.id, "2026-09");
    expect(events.map((e) => e.type)).toEqual(["project.created"]);
    expect(changes).toEqual([{ projectId: project.id, events }]);
  });

  it("取消订阅后不再收到通知", async () => {
    const store = await open();
    const actor = await cliActor(store);
    const changes: StoreChange[] = [];
    const unsubscribe = store.subscribe((change) => changes.push(change));
    unsubscribe();
    await store.createProject({ name: "看板" }, actor);
    expect(changes).toEqual([]);
  });

  it("没有变化的修改不写文件、不通知", async () => {
    const store = await open();
    const actor = await cliActor(store);
    const { project } = await store.createProject({ name: "看板" }, actor);
    const changes: StoreChange[] = [];
    store.subscribe((change) => changes.push(change));
    expect(await store.updateProject(project.id, { name: "看板" }, actor)).toEqual(project);
    expect(changes).toEqual([]);
    expect(await readEventLines(project.id, "2026-09")).toHaveLength(1);
  });

  it("网页带的版本号过期时报 conflict，数据不变", async () => {
    const store = await open();
    const actor = await cliActor(store);
    const { project } = await store.createProject({ name: "看板" }, actor);
    await store.updateProject(project.id, { focus: "A" }, actor);
    const err = await rejection(store.updateProject(project.id, { focus: "B" }, actor, { expectedVersion: 1 }));
    expect((err as KhError).code).toBe("conflict");
    expect(store.getProject(project.id)).toMatchObject({ focus: "A", version: 2 });
  });

  it("校验失败时什么都不写", async () => {
    const store = await open();
    const actor = await cliActor(store);
    const { project, board } = await store.createProject({ name: "看板" }, actor);
    const err = await rejection(store.createTask(project.id, { containerId: board.containers[0]!.id, title: "" }, actor));
    expect((err as KhError).code).toBe("invalid");
    expect(store.getBoard(project.id)?.tasks).toEqual([]);
    expect(await readEventLines(project.id, "2026-09")).toHaveLength(1);
  });

  it("项目不存在时报 not_found", async () => {
    const store = await open();
    const err = await rejection(store.appendLog("zzzzzzzzzz", { text: "x" }, await cliActor(store)));
    expect((err as KhError).code).toBe("not_found");
  });

  it("关闭之后拒绝新的写入", async () => {
    const store = await open();
    const actor = await cliActor(store);
    await store.close();
    const err = await rejection(store.createProject({ name: "看板" }, actor));
    expect((err as KhError).code).toBe("unavailable");
  });
});

describe("git 提交", () => {
  it("关闭时提交：作者是用户，提交者是 kanban-hub，说明按事件类型汇总", async () => {
    const store = await open();
    const mac = await cliActor(store, "mac");
    const { project } = await store.createProject({ name: "看板" }, mac);
    await store.updateProject(project.id, { focus: "M1" }, mac);
    expect(store.pendingCommitCount()).toBe(3);
    await store.close();
    expect(await git("log", "-1", "--format=%s|%an <%ae>|%cn")).toBe(
      `cli(mac): 1 项新建项目、1 项项目更新|Alice <${mac.userId}@kanban-hub.local>|kanban-hub`,
    );
    expect(await git("status", "--porcelain")).toBe("");
  });

  it("两个操作者写同一个项目时各成一个提交", async () => {
    const store = await open();
    const mac = await cliActor(store, "mac");
    const linux = await cliActor(store, "linux");
    const { project } = await store.createProject({ name: "看板" }, mac);
    await store.updateProject(project.id, { focus: "来自 linux" }, linux);
    await store.close();
    expect((await git("log", "--format=%s")).split("\n").slice(0, 2)).toEqual([
      "cli(linux): 1 项项目更新",
      "cli(mac): 1 项新建项目",
    ]);
  });
});

describe("查询事件", () => {
  it("按时间倒序，可以按项目筛选、用游标翻页", async () => {
    const store = await open();
    const actor = await cliActor(store);
    const a = (await store.createProject({ name: "A" }, actor)).project;
    await store.createProject({ name: "B" }, actor);
    await store.appendLog(a.id, { text: "第一条" }, actor);
    await store.appendLog(a.id, { text: "第二条" }, actor);
    expect((await store.listEvents({ limit: 10 })).map((e) => e.text)).toEqual(["第二条", "第一条", "B", "A"]);
    const page1 = await store.listEvents({ projectId: a.id, limit: 2 });
    expect(page1.map((e) => e.text)).toEqual(["第二条", "第一条"]);
    const page2 = await store.listEvents({ projectId: a.id, limit: 2, before: page1[1]! });
    expect(page2.map((e) => e.text)).toEqual(["A"]);
  });

  it("内存里不够时读更早月份的文件", async () => {
    const first = await open();
    const actor = await cliActor(first);
    const { project } = await first.createProject({ name: "看板" }, actor);
    await first.close();
    const old: Event = {
      id: "old0000001",
      ts: "2026-01-15T00:00:00.000Z",
      projectId: project.id,
      actor,
      type: "log",
      target: null,
      change: null,
      text: "旧日志",
      imported: true,
    };
    await fs.writeFile(path.join(dir, "projects", project.id, "events", "2026-01.jsonl"), `${JSON.stringify(old)}\n`);
    const second = await open();
    expect((await second.listEvents({ projectId: project.id, limit: 1 })).map((e) => e.text)).toEqual(["看板"]);
    expect((await second.listEvents({ projectId: project.id, limit: 5 })).map((e) => e.text)).toEqual(["看板", "旧日志"]);
  });

  it("最近 3 个月没有事件时，仍能取到最后一条事件的时间", async () => {
    const first = await open("2026-03-10T00:00:00.000Z");
    const { project } = await first.createProject({ name: "看板" }, await cliActor(first));
    await first.close();
    const second = await open("2026-09-23T10:00:00.000Z");
    expect(second.getLastEventAt(project.id)).toBe(project.createdAt);
    expect(await second.listEvents({ projectId: project.id, limit: 10 })).toHaveLength(1);
  });
});
