import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { KhError } from "@kanban-hub/core/errors";
import type { Actor, Event } from "@kanban-hub/core/schema";
import { readImportCounts, type TransferDoc } from "@kanban-hub/core/transfer";
import { GitRepo } from "./git";
import { Store, type StoreChange } from "./store";

let dir: string;
let opened: Store[];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "kh-store-import-"));
  opened = [];
});

afterEach(async () => {
  for (const store of opened) await store.close();
  await fs.rm(dir, { recursive: true, force: true });
});

/** 从 start 开始、每调用一次前进 1 秒的时钟 */
function clockFrom(start: string): () => Date {
  let tick = 0;
  return () => new Date(Date.parse(start) + 1000 * tick++);
}

/** 内存窗口是最近 3 个月：2026-07、08、09；2026-01 的事件只在文件里 */
async function open(start = "2026-09-23T10:00:00.000Z"): Promise<Store> {
  const store = await Store.open({ dataDir: dir, now: clockFrom(start), commitDebounceMs: 60_000, log: () => {} });
  opened.push(store);
  return store;
}

async function git(...args: string[]): Promise<string> {
  return (await new GitRepo(dir).run(args)).stdout.trim();
}

async function cliActor(store: Store, machineName = "mac"): Promise<Actor> {
  const user =
    store.auth.listUsers()[0] ?? (await store.auth.createUser({ name: "Alice", role: "admin", passwordHash: "x" }));
  const machine = await store.auth.createMachine({ name: machineName, userId: user.id, os: "darwin", tokenHash: "a".repeat(64) });
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

/** 数据目录下全部文件（含 .git）的路径与内容 hash */
async function hashTree(root: string, rel = ""): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
    const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(out, await hashTree(root, childRel));
    else if (entry.isFile()) out[childRel] = createHash("sha256").update(await fs.readFile(path.join(root, childRel))).digest("hex");
  }
  return out;
}

function eventFile(projectId: string, month: string): string {
  return path.join(dir, "projects", projectId, "events", `${month}.jsonl`);
}

/** 直接往某个月份的事件文件里写一条日志，模拟早于内存窗口的已有事件 */
async function seedLog(projectId: string, actor: Actor, id: string, ts: string, text: string): Promise<void> {
  const event: Event = { id, ts, projectId, actor, type: "log", target: null, change: null, text, imported: false };
  const file = eventFile(projectId, ts.slice(0, 7));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(event)}\n`);
}

const DOC: TransferDoc = {
  format: "kanban-hub/v1",
  project: { cycle: "development", health: "at_risk", focus: "迁移旧进度" },
  containers: [
    {
      kind: "phase",
      code: "P0",
      title: "工程骨架",
      tasks: [
        {
          code: "0.1",
          title: "初始化仓库",
          status: "done",
          startedAt: "2026-01-02T10:00:00+08:00",
          completedAt: "2026-01-05T18:00:00+08:00",
        },
        { code: "0.2", title: "写规格", status: "in_progress", startedAt: "2026-08-01T00:00:00Z" },
      ],
    },
    { kind: "misc", tasks: [{ title: "整理笔记" }] },
  ],
  events: [
    { ts: "2026-01-05T18:00:00+08:00", text: "完成工程骨架" },
    { ts: "2026-08-10T00:00:00Z", text: "开始写规格" },
  ],
};

describe("applyImport", () => {
  it("新建容器与任务，历史日期保留；board.yaml 重新打开后能加载回来", async () => {
    const store = await open();
    const actor = await cliActor(store);
    const { project } = await store.createProject({ name: "看板" }, actor);

    const summary = await store.applyImport(project.id, DOC, actor, { dryRun: false });
    expect(summary.dryRun).toBe(false);
    expect(summary.containers.created).toEqual([{ label: "P0" }]);
    expect(summary.tasks.created.map((t) => t.title)).toEqual(["初始化仓库", "写规格", "整理笔记"]);
    expect(summary.events).toEqual({ added: 2, duplicates: 0 });

    const task = store.getBoard(project.id)!.tasks.find((t) => t.code === "0.1")!;
    expect(task.startedAt).toBe("2026-01-02T02:00:00.000Z");
    expect(task.completedAt).toBe("2026-01-05T10:00:00.000Z");
    expect(store.getProject(project.id)?.health).toBe("at_risk");
    await store.close();

    const reopened = await open();
    expect(reopened.getBoard(project.id)).toEqual(store.getBoard(project.id));
    expect(reopened.getProject(project.id)?.focus).toBe("迁移旧进度");
  });

  it("历史日志写进对应的旧月份文件，listEvents 翻到那里时按时间顺序读到", async () => {
    const store = await open();
    const actor = await cliActor(store);
    const { project } = await store.createProject({ name: "看板" }, actor);
    // 旧月份文件里已有一条更晚的事件：导入追加的更早事件排在文件末尾，读取时仍按时间排
    await seedLog(project.id, actor, "seed000001", "2026-01-20T00:00:00.000Z", "旧月份已有日志");

    await store.applyImport(project.id, DOC, actor, { dryRun: false });

    const fileLines = (await fs.readFile(eventFile(project.id, "2026-01"), "utf8")).trim().split("\n");
    expect(fileLines.map((l) => (JSON.parse(l) as Event).text)).toEqual(["旧月份已有日志", "完成工程骨架"]);
    const imported = JSON.parse(fileLines[1]!) as Event;
    expect(imported).toMatchObject({ type: "log", imported: true, target: null, ts: "2026-01-05T10:00:00.000Z" });

    const logs = await store.listEvents({ projectId: project.id, types: ["log"], limit: 10 });
    expect(logs.map((e) => e.text)).toEqual(["开始写规格", "旧月份已有日志", "完成工程骨架"]);
    const all = await store.listEvents({ projectId: project.id, limit: 50 });
    expect(all[0]?.type).toBe("import.applied");
    expect(all.at(-1)?.text).toBe("完成工程骨架");
  });

  it("重复导入：不写文件、不产生事件、不产生新的 git 提交", async () => {
    const first = await open();
    const actor = await cliActor(first);
    const { project } = await first.createProject({ name: "看板" }, actor);
    await first.applyImport(project.id, DOC, actor, { dryRun: false });
    await first.close();

    const store = await open("2026-09-24T10:00:00.000Z");
    const commits = await git("rev-list", "--count", "HEAD");
    const before = await hashTree(dir);
    const changes: StoreChange[] = [];
    store.subscribe((c) => changes.push(c));

    const summary = await store.applyImport(project.id, DOC, actor, { dryRun: false });
    expect(summary.containers).toEqual({ created: [], updated: [] });
    expect(summary.tasks).toEqual({ created: [], updated: [], statusChanges: [] });
    expect(summary.project).toEqual([]);
    expect(summary.events).toEqual({ added: 0, duplicates: 2 });
    expect(changes).toEqual([]);
    expect(store.pendingCommitCount()).toBe(0);
    expect(await hashTree(dir)).toEqual(before);
    await store.close();
    expect(await git("rev-list", "--count", "HEAD")).toBe(commits);
  });

  it("dryRun：返回摘要，数据目录的全部文件前后一致", async () => {
    const store = await open();
    const actor = await cliActor(store);
    const { project } = await store.createProject({ name: "看板" }, actor);
    await seedLog(project.id, actor, "seed000001", "2026-01-20T00:00:00.000Z", "旧月份已有日志");
    const changes: StoreChange[] = [];
    store.subscribe((c) => changes.push(c));
    const before = await hashTree(dir);

    const summary = await store.applyImport(project.id, DOC, actor, { dryRun: true });
    expect(summary.dryRun).toBe(true);
    expect(summary.tasks.created).toHaveLength(3);
    expect(summary.events.added).toBe(2);
    expect(await hashTree(dir)).toEqual(before);
    expect(changes).toEqual([]);
    expect(store.getBoard(project.id)?.tasks).toEqual([]);
  });

  it("文件不合法：以 invalid 拒绝，带字段路径，什么都不写", async () => {
    const store = await open();
    const actor = await cliActor(store);
    const { project } = await store.createProject({ name: "看板" }, actor);
    const before = await hashTree(dir);

    const bad = { ...DOC, containers: [{ kind: "phase", title: "阶段", tasks: [{ title: "任务", status: "unknown" }] }] };
    const err = (await rejection(store.applyImport(project.id, bad as unknown as TransferDoc, actor, { dryRun: false }))) as KhError;
    expect(err.code).toBe("invalid");
    expect((err.details as { issues: string[] }).issues.join("\n")).toContain("containers[0].tasks[0].status");

    // 形状合法、但历史日志的时间晚于导入时间：同样什么都不写
    const future = { ...DOC, events: [{ ts: "2027-01-01T00:00:00Z", text: "未来" }] };
    expect(((await rejection(store.applyImport(project.id, future, actor, { dryRun: false }))) as KhError).code).toBe("invalid");
    expect(await hashTree(dir)).toEqual(before);
  });

  it("项目不存在时报 not_found", async () => {
    const store = await open();
    const actor = await cliActor(store);
    const err = (await rejection(store.applyImport("0000000000", DOC, actor, { dryRun: false }))) as KhError;
    expect(err.code).toBe("not_found");
  });

  it("导入产生的提交包含看板、项目和各个月份的事件文件", async () => {
    const store = await open();
    const actor = await cliActor(store);
    const { project } = await store.createProject({ name: "看板" }, actor);
    await store.close();
    const second = await open();
    await second.applyImport(project.id, DOC, actor, { dryRun: false });
    await second.close();

    const files = (await git("show", "--name-only", "--format=", "HEAD")).split("\n").sort();
    expect(files).toEqual(
      [
        `projects/${project.id}/board.yaml`,
        `projects/${project.id}/events/2026-01.jsonl`,
        `projects/${project.id}/events/2026-08.jsonl`,
        `projects/${project.id}/events/2026-09.jsonl`,
        `projects/${project.id}/project.yaml`,
      ].sort(),
    );
    expect(await git("log", "-1", "--format=%s")).toContain("导入");
    expect(await git("status", "--porcelain")).toBe("");
  });

  it("项目有多个月份的事件（含内存窗口之外的）时，在限定时间内完成", async () => {
    const store = await open();
    const actor = await cliActor(store);
    const { project } = await store.createProject({ name: "看板" }, actor);
    await seedLog(project.id, actor, "seed000001", "2025-11-03T00:00:00.000Z", "更早的日志");
    await seedLog(project.id, actor, "seed000002", "2026-02-03T00:00:00.000Z", "二月的日志");
    await seedLog(project.id, actor, "seed000003", "2026-08-03T00:00:00.000Z", "八月的日志");

    const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 3_000));
    const result = await Promise.race([store.applyImport(project.id, DOC, actor, { dryRun: false }), timeout]);
    expect(result).not.toBe("timeout");
  });

  it("已有日志（含非导入的、内存窗口之外的）与文件里的同一条日志按时间加正文去重", async () => {
    const store = await open();
    const actor = await cliActor(store);
    const { project } = await store.createProject({ name: "看板" }, actor);
    // 同一时刻换一种时区写法
    await seedLog(project.id, actor, "seed000001", "2026-01-05T10:00:00.000Z", "完成工程骨架");

    const summary = await store.applyImport(project.id, DOC, actor, { dryRun: false });
    expect(summary.events).toEqual({ added: 1, duplicates: 1 });
  });

  it("与并发发起的 listEvents、readProjectLogs 都能完成，后两者包含导入的历史日志", async () => {
    const store = await open();
    const actor = await cliActor(store);
    const { project } = await store.createProject({ name: "看板" }, actor);
    // 已有旧月份文件：listEvents 在内存不够时会进写入队列
    await seedLog(project.id, actor, "seed000001", "2026-01-20T00:00:00.000Z", "旧月份已有日志");

    const importing = store.applyImport(project.id, DOC, actor, { dryRun: false });
    const listing = store.listEvents({ projectId: project.id, types: ["log"], limit: 50 });
    const reading = store.readProjectLogs(project.id);
    const [, listed, logs] = await Promise.all([importing, listing, reading]);

    expect(listed.map((e) => e.text)).toEqual(["开始写规格", "旧月份已有日志", "完成工程骨架"]);
    expect(logs.map((e) => e.text)).toEqual(["完成工程骨架", "旧月份已有日志", "开始写规格"]);
  });

  it("订阅者只收到 import.applied 一条事件，计数与摘要一致", async () => {
    const store = await open();
    const actor = await cliActor(store);
    const { project } = await store.createProject({ name: "看板" }, actor);
    const changes: StoreChange[] = [];
    store.subscribe((c) => changes.push(c));

    await store.applyImport(project.id, DOC, actor, { dryRun: false });
    expect(changes).toHaveLength(1);
    expect(changes[0]!.projectId).toBe(project.id);
    expect(changes[0]!.events.map((e) => e.type)).toEqual(["import.applied"]);
    expect(readImportCounts(changes[0]!.events[0]!)).toEqual({
      projectFields: ["health", "focus"],
      containersCreated: 1,
      containersUpdated: 0,
      tasksCreated: 3,
      tasksUpdated: 0,
      logsAdded: 2,
    });
  });
});

describe("readProjectLogs", () => {
  it("按时间升序返回项目全部月份的 log 事件，只含 log", async () => {
    const store = await open();
    const actor = await cliActor(store);
    const { project } = await store.createProject({ name: "看板" }, actor);
    await seedLog(project.id, actor, "seed000002", "2026-02-03T00:00:00.000Z", "二月");
    await seedLog(project.id, actor, "seed000001", "2025-11-03T00:00:00.000Z", "十一月");
    await store.appendLog(project.id, { text: "今天" }, actor);

    const logs = await store.readProjectLogs(project.id);
    expect(logs.map((e) => e.text)).toEqual(["十一月", "二月", "今天"]);
  });

  it("项目不存在（含路径穿越）时报 not_found", async () => {
    const store = await open();
    expect(((await rejection(store.readProjectLogs("../../outside"))) as KhError).code).toBe("not_found");
  });
});
