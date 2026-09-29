import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SyncManifestInput } from "@kanban-hub/core/api";
import type { KhError } from "@kanban-hub/core/errors";
import type { Actor, Event } from "@kanban-hub/core/schema";
import { type IncomingFile, applyManifestDiff } from "@kanban-hub/core/sync";
import { DataFileError } from "./fsio";
import { GitRepo } from "./git";
import { INSTANCE_LOCK_FILE } from "./instance-lock";
import { type StagingMeta, resolveSnapshotPath } from "./snapshots";
import { DATA_GITIGNORE, DATA_GIT_ATTRIBUTES, Store, type StoreChange } from "./store";

let dir: string;
let opened: Store[];
let clockMs: number;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "kh-snap-"));
  opened = [];
  clockMs = Date.parse("2026-09-23T10:00:00.000Z");
});

afterEach(async () => {
  for (const store of opened) await store.close();
  await fs.rm(dir, { recursive: true, force: true });
});

/** 每调用一次前进 1 秒；测试里可以直接改 clockMs 让时间跳到将来 */
function now(): Date {
  clockMs += 1000;
  return new Date(clockMs);
}

async function open(): Promise<Store> {
  const store = await Store.open({ dataDir: dir, now, commitDebounceMs: 60_000, log: () => {} });
  opened.push(store);
  return store;
}

/**
 * 模拟进程被强杀：不关闭旧的 Store，直接重新打开（旧实例的提交定时器由 afterEach 统一关掉）。
 * 强杀会留下实例锁文件、持锁进程已死——起一个立刻退出的子进程拿它的 pid 写进锁文件，
 * 重新打开按“进程已死则接管”消化。
 */
async function reopen(): Promise<Store> {
  const child = spawn(process.execPath, ["-e", ""]);
  await once(child, "exit");
  await fs.writeFile(path.join(dir, INSTANCE_LOCK_FILE), `${child.pid}\n`);
  return open();
}

async function git(...args: string[]): Promise<string> {
  return (await new GitRepo(dir).run(args)).stdout.trim();
}

function sha(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function incoming(p: string, content: string | Uint8Array, base: string | null = null): IncomingFile {
  const bytes = typeof content === "string" ? Buffer.from(content) : content;
  return { path: p, sha256: sha(bytes), size: bytes.length, mtime: 1_700_000_000_000, base };
}

const SCOPE = { include: ["docs/**", "*.md"], exclude: [], maxFileSize: 1024 * 1024 };
const GIT_STATE = {
  branch: "main",
  head: "a".repeat(40),
  headSubject: "初始",
  headAt: "2026-09-23T09:00:00.000Z",
  dirtyCount: 0,
  ahead: null,
  behind: null,
};

function manifestInput(files: IncomingFile[], extra: Partial<SyncManifestInput> = {}): SyncManifestInput {
  return { files, git: GIT_STATE, skipped: [], scope: SCOPE, ...extra };
}

interface Fixture {
  store: Store;
  projectId: string;
  mac: Actor;
}

async function cliActor(store: Store, machineName: string): Promise<Actor> {
  const user =
    store.auth.listUsers()[0] ?? (await store.auth.createUser({ name: "Alice", role: "admin", passwordHash: "x" }));
  const machine = await store.auth.createMachine({ name: machineName, userId: user.id, os: "darwin", tokenHash: "a".repeat(64) });
  return { userId: user.id, machineId: machine.id, via: "cli", agent: null };
}

/** 建项目和一台登记了位置的机器 */
async function setup(): Promise<Fixture> {
  const store = await open();
  const mac = await cliActor(store, "mac");
  const { project } = await store.createProject({ name: "看板" }, mac);
  await store.setLocation(project.id, mac.machineId!, { path: "/repo" }, mac);
  return { store, projectId: project.id, mac };
}

async function addMachine(store: Store, projectId: string, name: string): Promise<Actor> {
  const actor = await cliActor(store, name);
  await store.setLocation(projectId, actor.machineId!, { path: `/${name}` }, actor);
  return actor;
}

/** 走完整的三步：manifest → 上传缺少的内容 → commit */
async function sync(store: Store, projectId: string, actor: Actor, contents: Record<string, string>) {
  const files = Object.entries(contents).map(([p, c]) => incoming(p, c));
  const begun = await store.beginSync(projectId, actor.machineId!, manifestInput(files));
  const byHash = new Map(Object.values(contents).map((c) => [sha(c), c]));
  for (const hash of begun.missing) await store.putSyncBlob(projectId, actor.machineId!, hash, Buffer.from(byHash.get(hash)!));
  return { begun, result: await store.commitSync(projectId, actor.machineId!, begun.syncId, actor) };
}

async function rejection(promise: Promise<unknown>): Promise<KhError> {
  try {
    await promise;
  } catch (e) {
    return e as KhError;
  }
  throw new Error("预期抛出错误");
}

function snapshotDir(projectId: string, machineId: string): string {
  return path.join(dir, "projects", projectId, "snapshots", machineId);
}

/** 快照目录下的全部文件：相对路径 → 内容 */
async function readTree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let entries;
  try {
    entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return out;
    throw e;
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    const abs = path.join(e.parentPath, e.name);
    out[path.relative(root, abs).split(path.sep).join("/")] = await fs.readFile(abs, "utf8");
  }
  return out;
}

async function readEvents(projectId: string): Promise<Event[]> {
  const eventsDir = path.join(dir, "projects", projectId, "events");
  const out: Event[] = [];
  for (const name of (await fs.readdir(eventsDir)).sort()) {
    const text = await fs.readFile(path.join(eventsDir, name), "utf8");
    out.push(...text.trim().split("\n").map((l) => JSON.parse(l) as Event));
  }
  return out;
}

/** 需要整体核对快照目录的标记（项目 ID.机器 ID） */
async function reconcileMarks(): Promise<string[]> {
  try {
    return (await fs.readdir(path.join(dir, ".staging", "reconcile"))).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

async function readMeta(syncId: string): Promise<StagingMeta> {
  return JSON.parse(await fs.readFile(path.join(dir, ".staging", syncId, "meta.json"), "utf8")) as StagingMeta;
}

async function stagingIds(): Promise<string[]> {
  try {
    return (await fs.readdir(path.join(dir, ".staging"))).filter((n) => n !== "reconcile").sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

describe("同步三步走通", () => {
  it("写入快照、清单、位置，记一条 docs.synced 并通知；提交的作者是这台机器的用户", async () => {
    const { store, projectId, mac } = await setup();
    const changes: StoreChange[] = [];
    store.subscribe((c) => changes.push(c));
    const base = sha("旧版本");
    const files = [incoming("docs/a.md", "# A"), incoming("README.md", "readme", base), incoming("docs/copy.md", "# A")];
    const begun = await store.beginSync(projectId, mac.machineId!, manifestInput(files, { skipped: [{ path: "docs/big.bin", size: 9 }] }));
    expect(begun.missing).toEqual([sha("# A"), sha("readme")].sort());
    expect(Date.parse(begun.expiresAt) - clockMs).toBeGreaterThan(23 * 3600_000);
    await store.putSyncBlob(projectId, mac.machineId!, sha("# A"), Buffer.from("# A"));
    await store.putSyncBlob(projectId, mac.machineId!, sha("readme"), Buffer.from("readme"));
    const result = await store.commitSync(projectId, mac.machineId!, begun.syncId, mac);

    expect(result).toMatchObject({ added: 3, modified: 0, removed: 0, unchanged: 0 });
    expect(await readTree(snapshotDir(projectId, mac.machineId!))).toEqual({
      "docs/a.md": "# A",
      "docs/copy.md": "# A",
      "README.md": "readme",
    });

    const manifest = store.getSnapshotManifest(projectId, mac.machineId!)!;
    expect(manifest.updatedAt).toBe(result.lastSyncAt);
    expect(manifest.files.map((f) => f.path)).toEqual(["README.md", "docs/a.md", "docs/copy.md"]);
    expect(manifest.files.every((f) => f.changedAt === result.lastSyncAt)).toBe(true);
    expect(manifest.files[0]!.base).toBe(base);
    const onDisk = JSON.parse(await fs.readFile(path.join(dir, "projects", projectId, "manifests", `${mac.machineId}.json`), "utf8"));
    expect(onDisk).toEqual(manifest);
    expect(store.listSnapshotManifests(projectId)).toEqual([manifest]);

    const location = store.getProject(projectId)!.locations[0]!;
    expect(location).toMatchObject({
      lastSyncAt: result.lastSyncAt,
      git: GIT_STATE,
      sync: SCOPE,
      skippedFiles: [{ path: "docs/big.bin", size: 9 }],
    });

    const synced = (await readEvents(projectId)).filter((e) => e.type === "docs.synced");
    expect(synced).toHaveLength(1);
    expect(synced[0]).toMatchObject({
      change: { added: { to: 3 }, modified: { to: 0 }, removed: { to: 0 } },
      text: null,
      target: null,
      actor: mac,
    });
    expect(changes.at(-1)).toEqual({ projectId, events: synced });
    expect(await stagingIds()).toEqual([]);

    await store.close();
    expect(await git("log", "-1", "--format=%an")).toBe("Alice");
    expect(await git("log", "-1", "--format=%s")).toContain("1 项文档同步");
    expect(await git("status", "--porcelain")).toBe("");
    expect(await git("ls-files", "--", `projects/${projectId}/snapshots`)).toContain("docs/copy.md");
  });

  it("再次同步、内容不变：missing 为空，不记事件，但更新 lastSyncAt 并通知", async () => {
    const { store, projectId, mac } = await setup();
    const first = await sync(store, projectId, mac, { "a.md": "a" });
    const eventsBefore = await readEvents(projectId);
    const changes: StoreChange[] = [];
    store.subscribe((c) => changes.push(c));
    const second = await sync(store, projectId, mac, { "a.md": "a" });
    expect(second.begun.missing).toEqual([]);
    expect(second.result).toMatchObject({ added: 0, modified: 0, removed: 0, unchanged: 1 });
    expect(second.result.lastSyncAt > first.result.lastSyncAt).toBe(true);
    expect(store.getProject(projectId)!.locations[0]!.lastSyncAt).toBe(second.result.lastSyncAt);
    expect(store.getSnapshotManifest(projectId, mac.machineId!)!.files[0]!.changedAt).toBe(first.result.lastSyncAt);
    expect(await readEvents(projectId)).toEqual(eventsBefore);
    expect(changes).toEqual([{ projectId, events: [] }]);
  });

  it("修改一个、删除一个、新增一个：计数正确，删掉的文件和空目录都不在了", async () => {
    const { store, projectId, mac } = await setup();
    const first = await sync(store, projectId, mac, { "keep.md": "k", "edit.md": "v1", "old/deep/gone.md": "g" });
    const { result } = await sync(store, projectId, mac, { "keep.md": "k", "edit.md": "v2", "new.md": "n" });
    expect(result).toMatchObject({ added: 1, modified: 1, removed: 1, unchanged: 1 });
    const root = snapshotDir(projectId, mac.machineId!);
    expect(await readTree(root)).toEqual({ "keep.md": "k", "edit.md": "v2", "new.md": "n" });
    await expect(fs.access(path.join(root, "old"))).rejects.toMatchObject({ code: "ENOENT" });
    const byPath = new Map(store.getSnapshotManifest(projectId, mac.machineId!)!.files.map((f) => [f.path, f]));
    expect(byPath.get("keep.md")!.changedAt).toBe(first.result.lastSyncAt);
    expect(byPath.get("edit.md")!.changedAt).toBe(result.lastSyncAt);
    const synced = (await readEvents(projectId)).filter((e) => e.type === "docs.synced");
    expect(synced.at(-1)!.change).toEqual({ added: { to: 1 }, modified: { to: 1 }, removed: { to: 1 } });
  });

  it("原来的目录变成同名文件", async () => {
    const { store, projectId, mac } = await setup();
    await sync(store, projectId, mac, { "a/b.md": "b" });
    await sync(store, projectId, mac, { a: "file" });
    expect(await readTree(snapshotDir(projectId, mac.machineId!))).toEqual({ a: "file" });
  });

  it("二进制内容按字节保存，readSnapshotFile 原样读回", async () => {
    const { store, projectId, mac } = await setup();
    const bytes = new Uint8Array([0, 255, 128, 10, 13]);
    const begun = await store.beginSync(projectId, mac.machineId!, manifestInput([incoming("img.png", bytes)]));
    await store.putSyncBlob(projectId, mac.machineId!, sha(bytes), bytes);
    await store.commitSync(projectId, mac.machineId!, begun.syncId, mac);
    expect(await store.readSnapshotFile(projectId, mac.machineId!, "img.png")).toEqual(bytes);
  });
});

describe("去重", () => {
  it("机器 B 同步与 A 相同的内容：missing 为空，快照照样写全", async () => {
    const { store, projectId, mac } = await setup();
    const linux = await addMachine(store, projectId, "linux");
    await sync(store, projectId, mac, { "a.md": "same", "docs/b.md": "bbb" });
    const { begun, result } = await sync(store, projectId, linux, { "x/a.md": "same", "docs/b.md": "bbb" });
    expect(begun.missing).toEqual([]);
    expect(result.added).toBe(2);
    expect(await readTree(snapshotDir(projectId, linux.machineId!))).toEqual({ "x/a.md": "same", "docs/b.md": "bbb" });
  });

  it("本机改名（旧路径删除、新路径同样内容）：内容取自自己的旧快照，删除之前已经保存下来", async () => {
    const { store, projectId, mac } = await setup();
    await sync(store, projectId, mac, { "old.md": "content" });
    const { begun } = await sync(store, projectId, mac, { "new.md": "content" });
    expect(begun.missing).toEqual([]);
    expect(await readTree(snapshotDir(projectId, mac.machineId!))).toEqual({ "new.md": "content" });
  });

  it("可复用的快照文件被改坏时当作缺失，commit 返回 missingBlobs", async () => {
    const { store, projectId, mac } = await setup();
    const linux = await addMachine(store, projectId, "linux");
    await sync(store, projectId, mac, { "a.md": "same" });
    await fs.writeFile(path.join(snapshotDir(projectId, mac.machineId!), "a.md"), "tampered");
    const begun = await store.beginSync(projectId, linux.machineId!, manifestInput([incoming("a.md", "same")]));
    expect(begun.missing).toEqual([]);
    const err = await rejection(store.commitSync(projectId, linux.machineId!, begun.syncId, linux));
    expect(err.code).toBe("invalid");
    expect(err.details).toEqual({ missingBlobs: [sha("same")] });

    // 同一份暂存可以补传，补传后 commit 成功
    await store.putSyncBlob(projectId, linux.machineId!, sha("same"), Buffer.from("same"));
    expect((await store.commitSync(projectId, linux.machineId!, begun.syncId, linux)).added).toBe(1);
    expect(await readTree(snapshotDir(projectId, linux.machineId!))).toEqual({ "a.md": "same" });
  });

  it("来源损坏的内容：之后的 manifest 不再当作已有；重新成功写入快照后恢复去重", async () => {
    const { store, projectId, mac } = await setup();
    const linux = await addMachine(store, projectId, "linux");
    await sync(store, projectId, mac, { "a.md": "same" });
    await fs.writeFile(path.join(snapshotDir(projectId, mac.machineId!), "a.md"), "tampered");
    const first = await store.beginSync(projectId, linux.machineId!, manifestInput([incoming("a.md", "same")]));
    await rejection(store.commitSync(projectId, linux.machineId!, first.syncId, linux));

    // kh 从头重来：这次 manifest 就把它列为缺少
    const second = await sync(store, projectId, linux, { "a.md": "same" });
    expect(second.begun.missing).toEqual([sha("same")]);
    const third = await store.beginSync(projectId, mac.machineId!, manifestInput([incoming("b.md", "same")]));
    expect(third.missing).toEqual([]);
  });
});

describe("beginSync 的校验", () => {
  it("项目不存在、本机没有位置时 404", async () => {
    const { store, projectId, mac } = await setup();
    expect((await rejection(store.beginSync("zzzzzzzzzz", mac.machineId!, manifestInput([])))).code).toBe("not_found");
    const other = await cliActor(store, "other");
    const err = await rejection(store.beginSync(projectId, other.machineId!, manifestInput([])));
    expect(err.code).toBe("not_found");
    expect(err.message).toBe("本机没有登记这个项目的位置，请执行 kh register");
  });

  it.each([
    ["../x", [incoming("../x", "x")]],
    [".git 段", [incoming("a/.git/config", "x")]],
    ["只差大小写", [incoming("A.md", "x"), incoming("a.md", "y")]],
    ["既是文件又是目录", [incoming("a", "x"), incoming("a/b", "y")]],
    ["只差大小写的上级目录", [incoming("A", "x"), incoming("a/b", "y")]],
    ["NFC 与 NFD 同名", [incoming("caf\u00e9.md", "x"), incoming("cafe\u0301.md", "y")]],
  ])("清单里的非法路径（%s）以 400 拒绝，不建暂存", async (_name, files) => {
    const { store, projectId, mac } = await setup();
    const err = await rejection(store.beginSync(projectId, mac.machineId!, manifestInput(files)));
    expect(err.code).toBe("invalid");
    expect(await stagingIds()).toEqual([]);
  });
});

describe("resolveSnapshotPath", () => {
  it("拼出快照目录内的绝对路径", () => {
    const root = path.join(dir, "snap");
    expect(resolveSnapshotPath(root, "a/b.md")).toBe(path.join(root, "a", "b.md"));
  });

  it.each(["../x", "a/../../x", "/etc/passwd", "a/.git/config", "a\\b", ""])("拒绝 %j", (p) => {
    let err: unknown;
    try {
      resolveSnapshotPath(path.join(dir, "snap"), p);
    } catch (e) {
      err = e;
    }
    expect((err as KhError).code).toBe("invalid");
  });
});

describe("中断与过期", () => {
  it("只做了 manifest 和部分上传就中断：旧快照完全不变", async () => {
    const { store, projectId, mac } = await setup();
    await sync(store, projectId, mac, { "a.md": "v1", "b.md": "b" });
    const manifestBefore = store.getSnapshotManifest(projectId, mac.machineId!);
    const begun = await store.beginSync(projectId, mac.machineId!, manifestInput([incoming("a.md", "v2"), incoming("c.md", "c")]));
    await store.putSyncBlob(projectId, mac.machineId!, sha("v2"), Buffer.from("v2"));

    const reopened = await reopen();
    expect(await readTree(snapshotDir(projectId, mac.machineId!))).toEqual({ "a.md": "v1", "b.md": "b" });
    expect(reopened.getSnapshotManifest(projectId, mac.machineId!)).toEqual(manifestBefore);
    // 没过期的暂存保留，可以继续上传并提交
    expect(await stagingIds()).toEqual([begun.syncId]);
    await reopened.putSyncBlob(projectId, mac.machineId!, sha("c"), Buffer.from("c"));
    await reopened.commitSync(projectId, mac.machineId!, begun.syncId, mac);
    expect(await readTree(snapshotDir(projectId, mac.machineId!))).toEqual({ "a.md": "v2", "c.md": "c" });
  });

  it("过期的暂存：收到新的 manifest 时被清理，再 commit 返回 404", async () => {
    const { store, projectId, mac } = await setup();
    const stale = await store.beginSync(projectId, mac.machineId!, manifestInput([incoming("a.md", "a")]));
    clockMs += 25 * 3600_000;
    const err = await rejection(store.commitSync(projectId, mac.machineId!, stale.syncId, mac));
    expect(err.code).toBe("not_found");
    expect(err.message).toBe("同步会话不存在或已过期");
    const fresh = await store.beginSync(projectId, mac.machineId!, manifestInput([incoming("a.md", "a")]));
    expect(await stagingIds()).toEqual([fresh.syncId]);
    expect(store.getSnapshotManifest(projectId, mac.machineId!)).toBeNull();
  });

  it("过期的暂存在启动时被清理", async () => {
    const { store, projectId, mac } = await setup();
    await store.beginSync(projectId, mac.machineId!, manifestInput([incoming("a.md", "a")]));
    clockMs += 25 * 3600_000;
    await reopen();
    expect(await stagingIds()).toEqual([]);
  });

  it("暂存不属于本机或本项目时 404", async () => {
    const { store, projectId, mac } = await setup();
    const linux = await addMachine(store, projectId, "linux");
    const begun = await store.beginSync(projectId, mac.machineId!, manifestInput([]));
    expect((await rejection(store.commitSync(projectId, linux.machineId!, begun.syncId, linux))).code).toBe("not_found");
    expect((await rejection(store.commitSync(projectId, mac.machineId!, "../../x", mac))).code).toBe("not_found");
  });
});

describe("内容缺失", () => {
  it("commit 时内容不齐：返回 missingBlobs，暂存仍可用，快照没有任何改动", async () => {
    const { store, projectId, mac } = await setup();
    await sync(store, projectId, mac, { "a.md": "v1" });
    const eventsBefore = await readEvents(projectId);
    const begun = await store.beginSync(projectId, mac.machineId!, manifestInput([incoming("a.md", "v2"), incoming("b.md", "b")]));
    await store.putSyncBlob(projectId, mac.machineId!, sha("v2"), Buffer.from("v2"));
    const err = await rejection(store.commitSync(projectId, mac.machineId!, begun.syncId, mac));
    expect(err.code).toBe("invalid");
    expect(err.details).toEqual({ missingBlobs: [sha("b")] });
    expect(await readTree(snapshotDir(projectId, mac.machineId!))).toEqual({ "a.md": "v1" });
    expect(await readEvents(projectId)).toEqual(eventsBefore);
    const meta = JSON.parse(await fs.readFile(path.join(dir, ".staging", begun.syncId, "meta.json"), "utf8")) as StagingMeta;
    expect(meta.state).toBe("open");

    await store.putSyncBlob(projectId, mac.machineId!, sha("b"), Buffer.from("b"));
    expect((await store.commitSync(projectId, mac.machineId!, begun.syncId, mac)).added).toBe(1);
  });

  it("暂存里已上传的内容被改坏：删掉它、放回 missing，暂存仍为 open，补传后可以提交；不算来源损坏", async () => {
    const { store, projectId, mac } = await setup();
    const begun = await store.beginSync(projectId, mac.machineId!, manifestInput([incoming("a.md", "a")]));
    await store.putSyncBlob(projectId, mac.machineId!, sha("a"), Buffer.from("a"));
    const blob = path.join(dir, ".staging", begun.syncId, "blobs", sha("a"));
    await fs.writeFile(blob, "损坏的内容");
    const err = await rejection(store.commitSync(projectId, mac.machineId!, begun.syncId, mac));
    expect(err.details).toEqual({ missingBlobs: [sha("a")] });
    await expect(fs.access(blob)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readMeta(begun.syncId)).toMatchObject({ state: "open", missing: [sha("a")] });
    await store.putSyncBlob(projectId, mac.machineId!, sha("a"), Buffer.from("a"));
    expect((await store.commitSync(projectId, mac.machineId!, begun.syncId, mac)).added).toBe(1);
    expect(await readTree(snapshotDir(projectId, mac.machineId!))).toEqual({ "a.md": "a" });
    expect(await reconcileMarks()).toEqual([]);
    // 这份内容之后照常算作已有：另一台机器同步同样的内容不需要再上传
    const linux = await addMachine(store, projectId, "linux");
    expect((await store.beginSync(projectId, linux.machineId!, manifestInput([incoming("b.md", "a")]))).missing).toEqual([]);
  });
});

describe("快照目录里的意外情况", () => {
  it("旧清单里的 d/x.md 在磁盘上的父路径 d 变成了文件：删除当作已完成，同步照常成功", async () => {
    const { store, projectId, mac } = await setup();
    await sync(store, projectId, mac, { "d/x.md": "x" });
    const root = snapshotDir(projectId, mac.machineId!);
    await fs.rm(path.join(root, "d"), { recursive: true });
    await fs.writeFile(path.join(root, "d"), "杂散文件");
    const { result } = await sync(store, projectId, mac, { "a.md": "a" });
    expect(result).toMatchObject({ added: 1, removed: 1 });
    expect((await readTree(root))["a.md"]).toBe("a");
  });

  it("旧清单里的 x.md 在磁盘上变成了目录：连同内容删除，同步照常成功", async () => {
    const { store, projectId, mac } = await setup();
    await sync(store, projectId, mac, { "x.md": "x" });
    const root = snapshotDir(projectId, mac.machineId!);
    await fs.rm(path.join(root, "x.md"));
    await fs.mkdir(path.join(root, "x.md", "junk"), { recursive: true });
    await fs.writeFile(path.join(root, "x.md", "junk", "f"), "f");
    await sync(store, projectId, mac, { "a.md": "a" });
    expect(await readTree(root)).toEqual({ "a.md": "a" });
    await expect(fs.access(path.join(root, "x.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")("父目录被换成软链接：写入不穿过它，删除也不碰链接指向的文件", async () => {
    const { store, projectId, mac } = await setup();
    await sync(store, projectId, mac, { "d/x.md": "x" });
    const root = snapshotDir(projectId, mac.machineId!);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "kh-outside-"));
    try {
      await fs.writeFile(path.join(outside, "x.md"), "外面的文件");
      await fs.rm(path.join(root, "d"), { recursive: true });
      await fs.symlink(outside, path.join(root, "d"));
      // 删除 d/x.md 不能删到外面的 x.md；写入 d/e.md 不能写到外面
      await sync(store, projectId, mac, { "d/e.md": "e" });
      expect(await fs.readFile(path.join(outside, "x.md"), "utf8")).toBe("外面的文件");
      expect(await fs.readdir(outside)).toEqual(["x.md"]);
      expect((await fs.lstat(path.join(root, "d"))).isDirectory()).toBe(true);
      expect(await readTree(root)).toEqual({ "d/e.md": "e" });
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("整体核对时 FIFO 等特殊文件直接当作杂散项删除，不去读它", async () => {
    const { store, projectId, mac } = await setup();
    await sync(store, projectId, mac, { "a.md": "a" });
    const root = snapshotDir(projectId, mac.machineId!);
    execFileSync("mkfifo", [path.join(root, "a.md.fifo")]);
    await fs.rm(path.join(root, "a.md"));
    execFileSync("mkfifo", [path.join(root, "a.md")]);
    await store.close();
    await fs.mkdir(path.join(dir, ".staging", "reconcile"), { recursive: true });
    await fs.writeFile(path.join(dir, ".staging", "reconcile", `${projectId}.${mac.machineId}`), "");
    const reopened = await reopen();
    // a.md 的来源现在是 FIFO：读不出内容，先报缺失；kh 重来时上传
    const first = await reopened.beginSync(projectId, mac.machineId!, manifestInput([incoming("a.md", "a")]));
    expect((await rejection(reopened.commitSync(projectId, mac.machineId!, first.syncId, mac))).details).toEqual({
      missingBlobs: [sha("a")],
    });
    await sync(reopened, projectId, mac, { "a.md": "a" });
    expect(await readTree(root)).toEqual({ "a.md": "a" });
    expect(await fs.readdir(root)).toEqual(["a.md"]);
    expect(await reconcileMarks()).toEqual([]);
  });

  it(".staging/reconcile 是普通文件时照常启动，之后能正常打标记", async () => {
    const { store, projectId, mac } = await setup();
    await store.close();
    await fs.mkdir(path.join(dir, ".staging"), { recursive: true });
    await fs.writeFile(path.join(dir, ".staging", "reconcile"), "x");
    const reopened = await reopen();
    await writeStaging(applyingMeta({ store: reopened, projectId, mac }, { "a.md": "A" }, "applying", { committedAt: "2026-09-21T10:00:00.000Z" }), {});
    await reopened.close();
    await reopen();
    expect(await reconcileMarks()).toEqual([`${projectId}.${mac.machineId}`]);
  });
});

describe("上传内容", () => {
  it("hash 与内容不符时 400；没有等待它的同步时 400", async () => {
    const { store, projectId, mac } = await setup();
    await store.beginSync(projectId, mac.machineId!, manifestInput([incoming("a.md", "a")]));
    expect((await rejection(store.putSyncBlob(projectId, mac.machineId!, sha("a"), Buffer.from("b")))).code).toBe("invalid");
    const err = await rejection(store.putSyncBlob(projectId, mac.machineId!, sha("z"), Buffer.from("z")));
    expect(err.code).toBe("invalid");
    expect(err.message).toBe("没有等待这份内容的同步");
    expect((await rejection(store.putSyncBlob(projectId, mac.machineId!, "../x", Buffer.from("z")))).code).toBe("invalid");
  });

  it("两份并行的暂存都要同一个 hash 时，都能拿到", async () => {
    const { store, projectId, mac } = await setup();
    const one = await store.beginSync(projectId, mac.machineId!, manifestInput([incoming("a.md", "a")]));
    const two = await store.beginSync(projectId, mac.machineId!, manifestInput([incoming("b.md", "a")]));
    await store.putSyncBlob(projectId, mac.machineId!, sha("a"), Buffer.from("a"));
    for (const id of [one.syncId, two.syncId]) {
      expect(await fs.readFile(path.join(dir, ".staging", id, "blobs", sha("a")), "utf8")).toBe("a");
    }
    await store.commitSync(projectId, mac.machineId!, two.syncId, mac);
    expect(await readTree(snapshotDir(projectId, mac.machineId!))).toEqual({ "b.md": "a" });
  });
});

/** 直接构造一份暂存，模拟应用到一半时崩溃 */
async function writeStaging(meta: StagingMeta, blobs: Record<string, string>): Promise<void> {
  const stagingDir = path.join(dir, ".staging", meta.syncId);
  await fs.mkdir(path.join(stagingDir, "blobs"), { recursive: true });
  await fs.writeFile(path.join(stagingDir, "meta.json"), JSON.stringify(meta));
  for (const content of Object.values(blobs)) await fs.writeFile(path.join(stagingDir, "blobs", sha(content)), content);
}

function applyingMeta(
  fx: Fixture,
  contents: Record<string, string>,
  state: StagingMeta["state"] = "applying",
  opts: { syncId?: string; committedAt?: string; eventId?: string; counts?: NonNullable<StagingMeta["applying"]>["counts"] } = {},
): StagingMeta {
  const files = Object.entries(contents).map(([p, c]) => incoming(p, c));
  return {
    syncId: opts.syncId ?? "0123456789abcdef0123456789abcdef",
    projectId: fx.projectId,
    machineId: fx.mac.machineId!,
    createdAt: "2026-09-23T10:05:00.000Z",
    expiresAt: "2026-09-24T10:05:00.000Z",
    state,
    missing: [],
    input: manifestInput(files) as StagingMeta["input"],
    applying: {
      committedAt: opts.committedAt ?? "2026-09-23T10:06:00.000Z",
      actor: fx.mac,
      eventId: opts.eventId ?? "evt0000001",
      counts: opts.counts ?? { added: files.length, modified: 0, removed: 0, unchanged: 0 },
    },
  };
}

describe("崩溃后重放", () => {
  it("applying 的暂存：启动时应用、补提交、删除暂存；重放两次结果与一次相同", async () => {
    const fx = await setup();
    await fx.store.close();
    const contents = { "docs/a.md": "A", "b.md": "B" };
    const meta = applyingMeta(fx, contents);
    await writeStaging(meta, contents);

    const store = await reopen();
    const root = snapshotDir(fx.projectId, fx.mac.machineId!);
    expect(await readTree(root)).toEqual(contents);
    expect(await stagingIds()).toEqual([]);
    expect(store.getSnapshotManifest(fx.projectId, fx.mac.machineId!)).toMatchObject({ updatedAt: meta.applying!.committedAt });
    expect(store.getProject(fx.projectId)!.locations[0]!.lastSyncAt).toBe(meta.applying!.committedAt);
    const synced = (await readEvents(fx.projectId)).filter((e) => e.type === "docs.synced");
    expect(synced).toHaveLength(1);
    expect(synced[0]).toMatchObject({ id: "evt0000001", ts: meta.applying!.committedAt, actor: fx.mac });
    expect(await git("status", "--porcelain")).toBe("");
    expect(await git("show", "--name-only", "--format=%s", "HEAD")).toContain(`projects/${fx.projectId}/snapshots/${fx.mac.machineId}/docs/a.md`);

    const snapshotFiles = await readTree(path.join(dir, "projects", fx.projectId));
    await store.close();
    // 事件已经追加、各步都已完成之后再重放一次：不重复记事件，所有文件不变
    await writeStaging(meta, contents);
    const again = await reopen();
    expect(await readTree(path.join(dir, "projects", fx.projectId))).toEqual(snapshotFiles);
    expect((await readEvents(fx.projectId)).filter((e) => e.type === "docs.synced")).toHaveLength(1);
    expect(await stagingIds()).toEqual([]);
    expect(again.getProject(fx.projectId)!.version).toBe(store.getProject(fx.projectId)!.version);
  });

  it("applied 的暂存：直接删除，不重复记事件", async () => {
    const fx = await setup();
    await fx.store.close();
    const eventsBefore = await readEvents(fx.projectId);
    await writeStaging(applyingMeta(fx, { "a.md": "A" }, "applied"), { "a.md": "A" });
    const store = await reopen();
    expect(await stagingIds()).toEqual([]);
    expect(await readEvents(fx.projectId)).toEqual(eventsBefore);
    expect(store.getSnapshotManifest(fx.projectId, fx.mac.machineId!)).toBeNull();
  });

  it("所需内容缺失的 applying 暂存：回到 open 等补传，快照不变；补传后可以提交", async () => {
    const fx = await setup();
    await fx.store.close();
    const meta = applyingMeta(fx, { "a.md": "A" });
    await writeStaging(meta, {});
    const store = await reopen();
    expect(await readMeta(meta.syncId)).toMatchObject({ state: "open", applying: null, missing: [sha("A")] });
    expect(store.getSnapshotManifest(fx.projectId, fx.mac.machineId!)).toBeNull();
    expect(await readTree(snapshotDir(fx.projectId, fx.mac.machineId!))).toEqual({});
    await store.putSyncBlob(fx.projectId, fx.mac.machineId!, sha("A"), Buffer.from("A"));
    await store.commitSync(fx.projectId, fx.mac.machineId!, meta.syncId, fx.mac);
    expect(await readTree(snapshotDir(fx.projectId, fx.mac.machineId!))).toEqual({ "a.md": "A" });
    expect(await reconcileMarks()).toEqual([]);
  });

  it("applying 暂存里的内容与 hash 不符、快照已改了一部分：回到 open；之后另一次同步整体核对，快照与清单一致", async () => {
    const fx = await setup();
    await sync(fx.store, fx.projectId, fx.mac, { "x.md": "x", "y.md": "y" });
    await fx.store.close();
    const root = snapshotDir(fx.projectId, fx.mac.machineId!);
    const meta = applyingMeta(fx, { "y.md": "y2" }, "applying", {
      committedAt: "2026-09-23T12:00:00.000Z",
      counts: { added: 0, modified: 1, removed: 1, unchanged: 0 },
    });
    await writeStaging(meta, {});
    await fs.writeFile(path.join(dir, ".staging", meta.syncId, "blobs", sha("y2")), "损坏的内容");
    // 崩溃前已经删掉了 x.md
    await fs.rm(path.join(root, "x.md"));

    const store = await reopen();
    expect(await readMeta(meta.syncId)).toMatchObject({ state: "open", missing: [sha("y2")] });
    await expect(fs.access(path.join(dir, ".staging", meta.syncId, "blobs", sha("y2")))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await reconcileMarks()).toEqual([`${fx.projectId}.${fx.mac.machineId}`]);

    // kh 这边仍是原来的内容：第一次 commit 发现 x.md 的来源已经不在，报缺失；重来一次时上传它
    const first = await store.beginSync(fx.projectId, fx.mac.machineId!, manifestInput([incoming("x.md", "x"), incoming("y.md", "y")]));
    expect(first.missing).toEqual([]);
    expect((await rejection(store.commitSync(fx.projectId, fx.mac.machineId!, first.syncId, fx.mac))).details).toEqual({
      missingBlobs: [sha("x")],
    });
    const again = await sync(store, fx.projectId, fx.mac, { "x.md": "x", "y.md": "y" });
    expect(again.begun.missing).toEqual([sha("x")]);
    expect(again.result).toMatchObject({ added: 0, modified: 0, removed: 0, unchanged: 2 });
    expect(await readTree(root)).toEqual({ "x.md": "x", "y.md": "y" });
    expect(await reconcileMarks()).toEqual([]);
  });

  it("从 committedAt 起超过有效期仍没应用完的 applying 暂存：丢弃并打上整体核对标记", async () => {
    const fx = await setup();
    await fx.store.close();
    await writeStaging(applyingMeta(fx, { "a.md": "A" }, "applying", { committedAt: "2026-09-21T10:00:00.000Z" }), { "a.md": "A" });
    const store = await reopen();
    expect(await stagingIds()).toEqual([]);
    expect(store.getSnapshotManifest(fx.projectId, fx.mac.machineId!)).toBeNull();
    expect(await readTree(snapshotDir(fx.projectId, fx.mac.machineId!))).toEqual({});
    expect(await reconcileMarks()).toEqual([`${fx.projectId}.${fx.mac.machineId}`]);
  });

  it("这台机器的清单比 applying 暂存新（收尾出过错）：丢弃，不回滚快照", async () => {
    const fx = await setup();
    clockMs = Date.parse("2026-09-23T11:00:00.000Z");
    await sync(fx.store, fx.projectId, fx.mac, { "a.md": "new" });
    await fx.store.close();
    await writeStaging(applyingMeta(fx, { "a.md": "old" }), { "a.md": "old" });
    await reopen();
    expect(await readTree(snapshotDir(fx.projectId, fx.mac.machineId!))).toEqual({ "a.md": "new" });
    expect(await stagingIds()).toEqual([]);
  });

  it("快照目录里有挡路的杂散文件：写入前当作杂散项删掉，同步照常成功", async () => {
    const { store, projectId, mac } = await setup();
    await sync(store, projectId, mac, { "a.md": "a" });
    const root = snapshotDir(projectId, mac.machineId!);
    await fs.writeFile(path.join(root, "d"), "杂散文件");
    const { result } = await sync(store, projectId, mac, { "a.md": "a", "d/e.md": "e" });
    expect(result).toMatchObject({ added: 1, unchanged: 1 });
    expect(await readTree(root)).toEqual({ "a.md": "a", "d/e.md": "e" });
    expect(await stagingIds()).toEqual([]);
  });


  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "删除暂存目录失败：同步照常成功，这份暂存不再被当作可用或待重放",
    async () => {
      const { store, projectId, mac } = await setup();
      const begun = await store.beginSync(projectId, mac.machineId!, manifestInput([incoming("a.md", "a")]));
      await store.putSyncBlob(projectId, mac.machineId!, sha("a"), Buffer.from("a"));
      await fs.chmod(path.join(dir, ".staging"), 0o555);
      try {
        expect((await store.commitSync(projectId, mac.machineId!, begun.syncId, mac)).added).toBe(1);
      } finally {
        await fs.chmod(path.join(dir, ".staging"), 0o755);
      }
      expect((await rejection(store.commitSync(projectId, mac.machineId!, begun.syncId, mac))).code).toBe("not_found");
      await sync(store, projectId, mac, { "a.md": "a", "b.md": "b" });
      expect(await readTree(snapshotDir(projectId, mac.machineId!))).toEqual({ "a.md": "a", "b.md": "b" });
      expect(await stagingIds()).toEqual([]);
    },
  );

  it("快照已部分删除和写入、清单仍是旧的：重放结果等于一次成功应用", async () => {
    const fx = await setup();
    const first = await sync(fx.store, fx.projectId, fx.mac, { "keep.md": "k", "edit.md": "v1", "old/deep/gone.md": "g" });
    await fx.store.close();
    const root = snapshotDir(fx.projectId, fx.mac.machineId!);
    const target = { "keep.md": "k", "edit.md": "v2", "new.md": "n" };
    const meta = applyingMeta(fx, target, "applying", {
      committedAt: "2026-09-23T12:00:00.000Z",
      counts: { added: 1, modified: 1, removed: 1, unchanged: 1 },
    });
    await writeStaging(meta, { "edit.md": "v2", "new.md": "n" });
    // 崩溃前已经删掉了 gone.md（空目录还在）、写好了 edit.md，还没写 new.md，清单也还是旧的
    await fs.rm(path.join(root, "old", "deep", "gone.md"));
    await fs.writeFile(path.join(root, "edit.md"), "v2");

    const store = await reopen();
    expect(await readTree(root)).toEqual(target);
    await expect(fs.access(path.join(root, "old"))).rejects.toMatchObject({ code: "ENOENT" });
    const byPath = new Map(store.getSnapshotManifest(fx.projectId, fx.mac.machineId!)!.files.map((f) => [f.path, f.changedAt]));
    expect(Object.fromEntries(byPath)).toEqual({
      "keep.md": first.result.lastSyncAt,
      "edit.md": "2026-09-23T12:00:00.000Z",
      "new.md": "2026-09-23T12:00:00.000Z",
    });
    const synced = (await readEvents(fx.projectId)).filter((e) => e.type === "docs.synced");
    expect(synced.at(-1)).toMatchObject({ id: "evt0000001", change: { added: { to: 1 }, modified: { to: 1 }, removed: { to: 1 } } });
    expect(await stagingIds()).toEqual([]);
    expect(await git("status", "--porcelain")).toBe("");
  });

  it("清单已写、project.yaml 未写时重放：补上位置和事件，清单不变", async () => {
    const fx = await setup();
    await fx.store.close();
    const contents = { "a.md": "A" };
    const meta = applyingMeta(fx, contents);
    await writeStaging(meta, contents);
    // 崩溃前快照和清单都已写好，位置和事件还没有
    const root = snapshotDir(fx.projectId, fx.mac.machineId!);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "a.md"), "A");
    const manifest = applyManifestDiff(null, meta.input.files, fx.mac.machineId!, meta.applying!.committedAt).next;
    await fs.mkdir(path.join(dir, "projects", fx.projectId, "manifests"), { recursive: true });
    await fs.writeFile(path.join(dir, "projects", fx.projectId, "manifests", `${fx.mac.machineId}.json`), JSON.stringify(manifest));

    const store = await reopen();
    expect(store.getSnapshotManifest(fx.projectId, fx.mac.machineId!)).toEqual(manifest);
    expect(store.getProject(fx.projectId)!.locations[0]!.lastSyncAt).toBe(meta.applying!.committedAt);
    const synced = (await readEvents(fx.projectId)).filter((e) => e.type === "docs.synced");
    expect(synced).toHaveLength(1);
    expect(synced[0]!.change).toEqual({ added: { to: 1 }, modified: { to: 0 }, removed: { to: 0 } });
    expect(await stagingIds()).toEqual([]);
  });

  it("同一台机器的多份 applying 暂存按 committedAt 先后应用，与 syncId 的顺序无关", async () => {
    const fx = await setup();
    await fx.store.close();
    const later = applyingMeta(fx, { "a.md": "later" }, "applying", {
      syncId: "0".repeat(32),
      committedAt: "2026-09-23T12:00:00.000Z",
      eventId: "evt0000002",
      counts: { added: 0, modified: 1, removed: 0, unchanged: 0 },
    });
    const earlier = applyingMeta(fx, { "a.md": "earlier" }, "applying", {
      syncId: "f".repeat(32),
      committedAt: "2026-09-23T11:00:00.000Z",
      eventId: "evt0000001",
    });
    await writeStaging(later, { "a.md": "later" });
    await writeStaging(earlier, { "a.md": "earlier" });
    const store = await reopen();
    expect(await readTree(snapshotDir(fx.projectId, fx.mac.machineId!))).toEqual({ "a.md": "later" });
    expect(store.getSnapshotManifest(fx.projectId, fx.mac.machineId!)!.updatedAt).toBe("2026-09-23T12:00:00.000Z");
    expect((await readEvents(fx.projectId)).filter((e) => e.type === "docs.synced").map((e) => e.id)).toEqual([
      "evt0000001",
      "evt0000002",
    ]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "运行期间应用中途失败：暂存保留为 applying，这台机器下次 commit 先把它应用完，再应用新的同步",
    async () => {
      const { store, projectId, mac } = await setup();
      await sync(store, projectId, mac, { "a/x.md": "x", "b/keep.md": "k" });
      const root = snapshotDir(projectId, mac.machineId!);
      const begun = await store.beginSync(projectId, mac.machineId!, manifestInput([incoming("b/keep.md", "k"), incoming("b/new.md", "n")]));
      await store.putSyncBlob(projectId, mac.machineId!, sha("n"), Buffer.from("n"));
      // b/ 只读：删除 a/x.md 能成功，写入 b/new.md 失败
      await fs.chmod(path.join(root, "b"), 0o555);
      try {
        const err = await rejection(store.commitSync(projectId, mac.machineId!, begun.syncId, mac));
        expect(err).toBeInstanceOf(Error);
      } finally {
        await fs.chmod(path.join(root, "b"), 0o755);
      }
      expect(await readTree(root)).toEqual({ "b/keep.md": "k" });
      const meta = JSON.parse(await fs.readFile(path.join(dir, ".staging", begun.syncId, "meta.json"), "utf8")) as StagingMeta;
      expect(meta.state).toBe("applying");
      expect(store.pendingCommitCount()).toBeGreaterThan(0);

      const next = await sync(store, projectId, mac, { "b/keep.md": "k", "b/new.md": "n", "c.md": "c" });
      expect(next.result).toMatchObject({ added: 1, modified: 0, removed: 0, unchanged: 2 });
      expect(await readTree(root)).toEqual({ "b/keep.md": "k", "b/new.md": "n", "c.md": "c" });
      expect(await stagingIds()).toEqual([]);
      const synced = (await readEvents(projectId)).filter((e) => e.type === "docs.synced");
      expect(synced.map((e) => e.change)).toEqual([
        { added: { to: 2 }, modified: { to: 0 }, removed: { to: 0 } },
        { added: { to: 1 }, modified: { to: 0 }, removed: { to: 1 } },
        { added: { to: 1 }, modified: { to: 0 }, removed: { to: 0 } },
      ]);
    },
  );

  it("绕过校验构造的越界路径：拒绝写到快照目录之外，丢弃暂存", async () => {
    const fx = await setup();
    await fx.store.close();
    const meta = applyingMeta(fx, { "a.md": "A" });
    meta.input.files[0]!.path = "../../../escaped.md";
    await writeStaging(meta, { "a.md": "A" });
    await reopen();
    await expect(fs.access(path.join(dir, "projects", fx.projectId, "escaped.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(dir, "escaped.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await stagingIds()).toEqual([]);
  });
});

describe("数据目录的 .gitignore 与临时目录", () => {
  it("旧内容启动时被重写；快照里名为 note.tmp-1.md 的文档能被提交", async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, ".gitignore"), "/auth/\n/.staging/\n*.tmp-*\n");
    const { store, projectId, mac } = await setup();
    expect(await fs.readFile(path.join(dir, ".gitignore"), "utf8")).toBe(DATA_GITIGNORE);
    expect(DATA_GITIGNORE).not.toContain("*.tmp-*");
    expect(DATA_GITIGNORE).toContain("/.tmp/");
    await sync(store, projectId, mac, { "note.tmp-1.md": "n" });
    await store.close();
    expect(await git("ls-files", "--", `projects/${projectId}/snapshots/${mac.machineId}/note.tmp-1.md`)).not.toBe("");
  });

  it("快照里带 .gitignore（内容为 *）时，启动补提交仍然纳入快照文件", async () => {
    const { store, projectId, mac } = await setup();
    await sync(store, projectId, mac, { ".gitignore": "*\n", "docs/a.md": "a" });
    // 不关闭：提交还在等待，由下次启动时的补提交完成
    await reopen();
    expect(await git("status", "--porcelain", "--ignored", "--", "projects")).toBe("");
    const tracked = await git("ls-files", "--", `projects/${projectId}/snapshots`);
    expect(tracked).toContain("docs/a.md");
    expect(tracked).toContain(".gitignore");
  });

  it("快照里带 * text eol=crlf 的 .gitattributes：提交进 git 的内容与原字节一致", async () => {
    const { store, projectId, mac } = await setup();
    expect(await fs.readFile(path.join(dir, ".git", "info", "attributes"), "utf8")).toBe(DATA_GIT_ATTRIBUTES);
    await sync(store, projectId, mac, { ".gitattributes": "* text eol=crlf ident\n", "a.md": "one\r\ntwo\r\n$Id$\n" });
    await store.close();
    const blob = await new GitRepo(dir).run(["cat-file", "blob", `HEAD:projects/${projectId}/snapshots/${mac.machineId}/a.md`]);
    expect(blob.stdout).toBe("one\r\ntwo\r\n$Id$\n");
  });

  it(".git/info/attributes 内容不一致时启动重写", async () => {
    await open().then((s) => s.close());
    await fs.writeFile(path.join(dir, ".git", "info", "attributes"), "* text\n");
    await reopen();
    expect(await fs.readFile(path.join(dir, ".git", "info", "attributes"), "utf8")).toBe(DATA_GIT_ATTRIBUTES);
  });

  it("启动时删除旧版本留下的 *.tmp-<pid>-<n>，快照里同名模式的文档不动", async () => {
    const { store, projectId, mac } = await setup();
    await sync(store, projectId, mac, { "x.tmp-12-3": "doc" });
    await store.close();
    const leftovers = [`projects/${projectId}/project.yaml.tmp-123-4`, "auth/users.yaml.tmp-1-2", ".gitignore.tmp-9-9"];
    for (const rel of leftovers) await fs.writeFile(path.join(dir, ...rel.split("/")), "x");
    await reopen();
    for (const rel of leftovers) await expect(fs.access(path.join(dir, ...rel.split("/")))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(snapshotDir(projectId, mac.machineId!), "x.tmp-12-3"), "utf8")).toBe("doc");
    expect(await git("status", "--porcelain")).toBe("");
  });

  it(".tmp/ 在启动时被清空", async () => {
    await open().then((s) => s.close());
    await fs.mkdir(path.join(dir, ".tmp"), { recursive: true });
    await fs.writeFile(path.join(dir, ".tmp", "leftover"), "x");
    await reopen();
    expect(await fs.readdir(path.join(dir, ".tmp"))).toEqual([]);
  });

  it("启动时清理 HEAD.lock 和 refs 下的锁文件", async () => {
    const first = await open();
    await first.createProject({ name: "看板" }, await cliActor(first, "mac"));
    await fs.writeFile(path.join(dir, ".git", "HEAD.lock"), "");
    await fs.writeFile(path.join(dir, ".git", "refs", "heads", "main.lock"), "");
    await reopen();
    await expect(fs.access(path.join(dir, ".git", "HEAD.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(dir, ".git", "refs", "heads", "main.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git("log", "-1", "--format=%s")).toBe("补提交上次未提交的改动");
  });
});

describe("清单加载", () => {
  it("清单文件损坏时拒绝启动，并指出是哪个文件", async () => {
    const { store, projectId, mac } = await setup();
    await sync(store, projectId, mac, { "a.md": "a" });
    await store.close();
    const file = path.join(dir, "projects", projectId, "manifests", `${mac.machineId}.json`);
    await fs.writeFile(file, JSON.stringify({ machineId: mac.machineId, updatedAt: "x", files: [] }));
    const err = await Store.open({ dataDir: dir, now, log: () => {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DataFileError);
    expect((err as DataFileError).file).toBe(file);
    await fs.writeFile(file, "{");
    const err2 = await Store.open({ dataDir: dir, now, log: () => {} }).catch((e: unknown) => e);
    expect(err2).toBeInstanceOf(DataFileError);
  });

  it("重新打开后清单从磁盘读回", async () => {
    const { store, projectId, mac } = await setup();
    await sync(store, projectId, mac, { "a.md": "a" });
    const manifest = store.getSnapshotManifest(projectId, mac.machineId!);
    await store.close();
    const reopened = await reopen();
    expect(reopened.getSnapshotManifest(projectId, mac.machineId!)).toEqual(manifest);
  });
});

describe("readSnapshotFile", () => {
  it("路径不在清单里、文件已被删除时返回 null", async () => {
    const { store, projectId, mac } = await setup();
    await sync(store, projectId, mac, { "a.md": "a" });
    expect(Buffer.from((await store.readSnapshotFile(projectId, mac.machineId!, "a.md"))!).toString()).toBe("a");
    expect(await store.readSnapshotFile(projectId, mac.machineId!, "b.md")).toBeNull();
    expect(await store.readSnapshotFile(projectId, mac.machineId!, "../a.md")).toBeNull();
    expect(await store.readSnapshotFile(projectId, "zzzzzzzzzz", "a.md")).toBeNull();
    await fs.rm(path.join(snapshotDir(projectId, mac.machineId!), "a.md"));
    expect(await store.readSnapshotFile(projectId, mac.machineId!, "a.md")).toBeNull();
  });
});

describe("recordPull", () => {
  it("追加一条 docs.pulled，change 带各项计数和来源机器", async () => {
    const { store, projectId, mac } = await setup();
    const linux = await addMachine(store, projectId, "linux");
    await store.recordPull(
      projectId,
      { created: 1, overwritten: 0, merged: 2, conflicts: 1, stale: 0, fromMachineIds: [linux.machineId!] },
      mac,
    );
    const pulled = (await readEvents(projectId)).filter((e) => e.type === "docs.pulled");
    expect(pulled).toHaveLength(1);
    expect(pulled[0]).toMatchObject({
      text: null,
      target: null,
      actor: mac,
      change: {
        created: { to: 1 },
        overwritten: { to: 0 },
        merged: { to: 2 },
        conflicts: { to: 1 },
        stale: { to: 0 },
        from: { to: [linux.machineId] },
      },
    });
  });

  it("计数全为 0 时 400；项目不存在时 404", async () => {
    const { store, projectId, mac } = await setup();
    const zero = { created: 0, overwritten: 0, merged: 0, conflicts: 0, stale: 0, fromMachineIds: [] };
    expect((await rejection(store.recordPull(projectId, zero, mac))).code).toBe("invalid");
    expect((await rejection(store.recordPull("zzzzzzzzzz", { ...zero, created: 1 }, mac))).code).toBe("not_found");
  });
});
