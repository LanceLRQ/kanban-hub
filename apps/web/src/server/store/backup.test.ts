import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TextReader, Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from "@zip.js/zip.js";
import { KhError } from "@kanban-hub/core/errors";
import type { Actor } from "@kanban-hub/core/schema";
import { KH_VERSION } from "@kanban-hub/core/version";
import {
  BACKUP_FILE_NAME_RE,
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  listBackupFiles,
  restoreArchive,
  writeBackupArchive,
} from "./backup";
import { GitRepo } from "./git";
import { Store } from "./store";

let root: string;
let dataDir: string;
let backupDir: string;
let opened: Store[];

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "kh-backup-"));
  dataDir = path.join(root, "data");
  backupDir = path.join(root, "backups");
  // 存储打开时 git 以数据目录为工作目录，目录得先存在
  await fs.mkdir(dataDir, { recursive: true });
  opened = [];
});

afterEach(async () => {
  for (const store of opened) await store.close();
  await fs.rm(root, { recursive: true, force: true });
});

/** 从 start 开始、每调用一次前进 1 秒的时钟，保证每次写操作的时间都不同 */
function clockFrom(start: string): () => Date {
  let tick = 0;
  return () => new Date(Date.parse(start) + 1000 * tick++);
}

/** 建一个有用户、机器、项目和任务的数据目录；改动留在待提交状态（提交去抖时间设得很长） */
async function seedData() {
  const store = await Store.open({
    dataDir,
    backupDir,
    now: clockFrom("2026-09-28T08:00:00.000Z"),
    commitDebounceMs: 60_000,
    log: () => {},
  });
  opened.push(store);
  const user = await store.auth.createUser({ name: "Alice", role: "admin", passwordHash: "x" });
  const machine = await store.auth.createMachine({
    name: "mac",
    userId: user.id,
    os: "darwin",
    tokenHash: "a".repeat(64),
  });
  const actor: Actor = { userId: user.id, machineId: machine.id, via: "cli", agent: null };
  const { project } = await store.createProject({ name: "看板" }, actor);
  const container = await store.createContainer(project.id, { kind: "phase", title: "阶段一", code: "M1" }, actor);
  await store.createTask(project.id, { containerId: container.id, title: "任务", code: "1.1" }, actor);
  // 写操作返回的是各自的旧对象，比较基准在这里取当前值
  return { store, actor, project: store.getProject(project.id)!, board: store.getBoard(project.id)!, events: await store.listEvents({ projectId: project.id, limit: 50 }) };
}

/** 把数据目录里全部文件读出来：相对路径（POSIX 分隔）→ 内容 */
async function diskFiles(dir: string, rel = ""): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      for (const [k, v] of await diskFiles(path.join(dir, entry.name), childRel)) out.set(k, v);
    } else if (entry.isFile()) {
      out.set(childRel, await fs.readFile(path.join(dir, entry.name)));
    }
  }
  return out;
}

/** 用 zip.js 把备份文件整个读出来：entry 名 → 内容 */
async function readZipBytes(file: string, password?: string): Promise<Map<string, Uint8Array>> {
  const bytes = await fs.readFile(file);
  const reader = new ZipReader(new Uint8ArrayReader(bytes), { password: password || undefined });
  try {
    const entries = await reader.getEntries();
    const result = new Map<string, Uint8Array>();
    for (const entry of entries) {
      if (entry.directory) continue;
      result.set(entry.filename, await entry.getData(new Uint8ArrayWriter()));
    }
    return result;
  } finally {
    await reader.close();
  }
}

/** 测试里手工拼一个 zip（用来造不合规的备份） */
async function writeCraftedZip(file: string, entries: Array<{ name: string; content: string }>): Promise<void> {
  const sink = new Uint8ArrayWriter();
  const writer = new ZipWriter(sink);
  for (const entry of entries) await writer.add(entry.name, new TextReader(entry.content));
  await writer.close();
  await fs.writeFile(file, await sink.getData());
}

function manifestText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: BACKUP_FORMAT,
    version: BACKUP_FORMAT_VERSION,
    createdAt: "2026-09-29T10:00:00.000Z",
    includeGit: true,
    khVersion: KH_VERSION,
    ...overrides,
  });
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a).equals(Buffer.from(b));
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error("预期抛出错误");
}

describe("打包备份", () => {
  it("数据目录全量进包：manifest 在根下，其余都在 data/ 前缀下，内容与磁盘逐文件一致", async () => {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, "top.txt"), "根文件");
    await fs.mkdir(path.join(dataDir, "projects", "p1"), { recursive: true });
    await fs.writeFile(path.join(dataDir, "projects", "p1", "board.yaml"), "containers: []\n");

    const info = await writeBackupArchive(dataDir, backupDir, { now: () => new Date("2026-09-29T10:00:00.000Z") });
    const zipped = await readZipBytes(path.join(backupDir, info.fileName));
    const disk = await diskFiles(dataDir);
    expect([...zipped.keys()].sort()).toEqual([...[...disk.keys()].map((r) => `data/${r}`), "manifest.json"].sort());
    expect(Buffer.from(zipped.get("data/top.txt")!).toString()).toBe("根文件");
    for (const [rel, content] of disk) {
      expect(sameBytes(zipped.get(`data/${rel}`)!, content), rel).toBe(true);
    }
    expect(info.size).toBe((await fs.stat(path.join(backupDir, info.fileName))).size);
  });

  it("manifest 字段正确：格式、版本、创建时间、含历史与 kh 版本", async () => {
    await fs.mkdir(dataDir, { recursive: true });
    const info = await writeBackupArchive(dataDir, backupDir, { now: () => new Date("2026-09-29T10:00:00.000Z") });
    expect(info.createdAt).toBe("2026-09-29T10:00:00.000Z");
    const zipped = await readZipBytes(path.join(backupDir, info.fileName));
    expect(JSON.parse(Buffer.from(zipped.get("manifest.json")!).toString())).toEqual({
      format: BACKUP_FORMAT,
      version: BACKUP_FORMAT_VERSION,
      createdAt: "2026-09-29T10:00:00.000Z",
      includeGit: true,
      khVersion: KH_VERSION,
    });
  });

  it("默认包含 .git 历史，auth 目录也在包里", async () => {
    await seedData();
    const info = await writeBackupArchive(dataDir, backupDir);
    const names = [...(await readZipBytes(path.join(backupDir, info.fileName))).keys()];
    expect(names.some((n) => n.startsWith("data/.git/"))).toBe(true);
    expect(names).toContain("data/auth/users.yaml");
    expect(names).toContain("data/auth/machines.yaml");
    expect(names.some((n) => n.startsWith("data/projects/"))).toBe(true);
  });

  it("includeGit: false 时排除 .git，manifest 标记 includeGit 为 false", async () => {
    await seedData();
    const info = await writeBackupArchive(dataDir, backupDir, { includeGit: false });
    const zipped = await readZipBytes(path.join(backupDir, info.fileName));
    expect([...zipped.keys()].some((n) => n.startsWith("data/.git/"))).toBe(false);
    expect([...zipped.keys()].some((n) => n.startsWith("data/projects/"))).toBe(true);
    expect(JSON.parse(Buffer.from(zipped.get("manifest.json")!).toString()).includeGit).toBe(false);
  });

  it("密码加密后 zip.js 能用同一密码读回，内容与磁盘逐文件一致", async () => {
    await seedData();
    const password = "打铁的炉火";
    const info = await writeBackupArchive(dataDir, backupDir, { password });
    const zipped = await readZipBytes(path.join(backupDir, info.fileName), password);
    const disk = await diskFiles(dataDir);
    expect([...zipped.keys()].sort()).toEqual([...[...disk.keys()].map((r) => `data/${r}`), "manifest.json"].sort());
    for (const [rel, content] of disk) {
      expect(sameBytes(zipped.get(`data/${rel}`)!, content), rel).toBe(true);
    }
  });

  it("文件名按本机时区生成", async () => {
    await fs.mkdir(dataDir, { recursive: true });
    // 用本地时间的年月日时分秒构造 Date，格式化结果必须回到同一组本地时间字段
    const info = await writeBackupArchive(dataDir, backupDir, { now: () => new Date(2026, 8, 29, 15, 30, 5) });
    expect(info.fileName).toBe("kanban-hub-20260929-153005.zip");
    expect(info.fileName).toMatch(BACKUP_FILE_NAME_RE);
  });

  it("同一秒创建多个备份时依次加 -1、-2 后缀", async () => {
    await fs.mkdir(dataDir, { recursive: true });
    const now = () => new Date(2026, 8, 29, 15, 30, 5);
    expect((await writeBackupArchive(dataDir, backupDir, { now })).fileName).toBe("kanban-hub-20260929-153005.zip");
    expect((await writeBackupArchive(dataDir, backupDir, { now })).fileName).toBe("kanban-hub-20260929-153005-1.zip");
    expect((await writeBackupArchive(dataDir, backupDir, { now })).fileName).toBe("kanban-hub-20260929-153005-2.zip");
  });

  it.skipIf(process.platform === "win32")("备份目录不可写时抛错且不留文件", async () => {
    await seedData();
    await fs.mkdir(backupDir, { recursive: true });
    await fs.chmod(backupDir, 0o500);
    try {
      const err = await rejection(writeBackupArchive(dataDir, backupDir));
      expect(err).toBeInstanceOf(Error);
      expect(await fs.readdir(backupDir)).toEqual([]);
    } finally {
      await fs.chmod(backupDir, 0o700);
    }
  });

  it("改名之后失败时，临时文件与产物都删除", async () => {
    await seedData();
    const realRename = fs.rename.bind(fs);
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (src, dest) => {
      await realRename(src, dest);
      throw new Error("改名之后失败");
    });
    try {
      await expect(writeBackupArchive(dataDir, backupDir)).rejects.toThrow("改名之后失败");
      expect(await fs.readdir(backupDir)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("恢复备份", () => {
  it("恢复到不存在的目录与空目录，恢复后存储重新加载全部数据一致", async () => {
    const seeded = await seedData();
    const info = await writeBackupArchive(dataDir, backupDir);
    const file = path.join(backupDir, info.fileName);
    const expectRestored = async (target: string) => {
      const result = await restoreArchive(file, target);
      expect(result.files).toBeGreaterThan(0);
      expect(result.manifest).toEqual({
        format: BACKUP_FORMAT,
        version: BACKUP_FORMAT_VERSION,
        createdAt: info.createdAt,
        includeGit: true,
        khVersion: KH_VERSION,
      });
      const reopened = await Store.open({ dataDir: target, commitDebounceMs: 60_000, log: () => {} });
      opened.push(reopened);
      expect(reopened.getProject(seeded.project.id)).toEqual(seeded.project);
      expect(reopened.getBoard(seeded.project.id)).toEqual(seeded.board);
      expect([...(await reopened.listEvents({ projectId: seeded.project.id, limit: 50 }))]).toEqual(seeded.events);
      expect(reopened.auth.listUsers().map((u) => u.name)).toEqual(["Alice"]);
      expect(reopened.auth.listMachines().map((m) => m.name)).toEqual(["mac"]);
    };

    // 不存在的目录
    await expectRestored(path.join(root, "restore-missing"));
    // 已存在的空目录
    await fs.mkdir(path.join(root, "restore-empty"));
    await expectRestored(path.join(root, "restore-empty"));
  });

  it(".git 的有无随包：默认包含，includeGit: false 时恢复出来没有 .git", async () => {
    await seedData();
    const withGit = await writeBackupArchive(dataDir, backupDir);
    const target1 = path.join(root, "r-git");
    await restoreArchive(path.join(backupDir, withGit.fileName), target1);
    await expect(fs.stat(path.join(target1, ".git"))).resolves.toBeTruthy();

    const withoutGit = await writeBackupArchive(dataDir, backupDir, { includeGit: false });
    const target2 = path.join(root, "r-nogit");
    await restoreArchive(path.join(backupDir, withoutGit.fileName), target2);
    await expect(fs.stat(path.join(target2, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("files 计数只算数据文件，manifest.json 不算；manifest 也不落进数据目录", async () => {
    await fs.mkdir(dataDir, { recursive: true });
    const file = path.join(root, "crafted-count.zip");
    await writeCraftedZip(file, [
      { name: "manifest.json", content: manifestText() },
      { name: "data/a.txt", content: "甲" },
      { name: "data/sub/b.txt", content: "乙" },
    ]);
    const target = path.join(root, "target");
    const result = await restoreArchive(file, target);
    expect(result.files).toBe(2);
    expect((await fs.readdir(target, { recursive: true })).sort()).toEqual(["a.txt", "sub", "sub/b.txt"]);
  });

  it("非空目录以 conflict 拒绝，原有内容不动", async () => {
    await seedData();
    const info = await writeBackupArchive(dataDir, backupDir);
    const target = path.join(root, "not-empty");
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "keep.txt"), "别动我");
    const err = await rejection(restoreArchive(path.join(backupDir, info.fileName), target));
    expect(err).toBeInstanceOf(KhError);
    expect((err as KhError).code).toBe("conflict");
    expect(await fs.readFile(path.join(target, "keep.txt"), "utf8")).toBe("别动我");
  });

  it("entry 名带 .. 段、绝对路径或根下多余文件都拒绝，什么都不写", async () => {
    await seedData();
    const cases: Array<{ name: string; content: string }> = [
      { name: "data/../../escape.txt", content: "越界" },
      { name: "/abs/evil.txt", content: "绝对路径" },
      { name: "stray.txt", content: "根下多余文件" },
    ];
    for (const bad of cases) {
      const file = path.join(root, `crafted-${bad.name.replace(/\W/g, "_")}.zip`);
      await writeCraftedZip(file, [
        { name: "manifest.json", content: manifestText() },
        { name: "data/keep.txt", content: "正常的" },
        bad,
      ]);
      const target = path.join(root, `t-${bad.name.replace(/\W/g, "_")}`);
      const err = await rejection(restoreArchive(file, target));
      expect(err, bad.name).toBeInstanceOf(KhError);
      expect((err as KhError).code, bad.name).toBe("invalid");
      expect(await fs.readdir(target).catch(() => []), bad.name).toEqual([]);
      expect(await fs.readdir(root), bad.name).not.toContain("escape.txt");
    }
  });

  it("manifest 的格式或版本不认识时拒绝", async () => {
    await seedData();
    const cases: Array<Record<string, unknown>> = [{ format: "另一个程序" }, { version: 2 }];
    for (const override of cases) {
      const file = path.join(root, `crafted-${JSON.stringify(override).replace(/\W/g, "_")}.zip`);
      await writeCraftedZip(file, [
        { name: "manifest.json", content: manifestText(override) },
        { name: "data/top.txt", content: "数据" },
      ]);
      const err = await rejection(restoreArchive(file, path.join(root, "target")));
      expect(err, JSON.stringify(override)).toBeInstanceOf(KhError);
      expect((err as KhError).code, JSON.stringify(override)).toBe("invalid");
    }
  });

  it("密码错误时给出中文错误，且不把密码写进错误信息", async () => {
    await seedData();
    const password = "正确的密码";
    const info = await writeBackupArchive(dataDir, backupDir, { password });
    const file = path.join(backupDir, info.fileName);
    const wrong = "错误的密码";
    const err = await rejection(restoreArchive(file, path.join(root, "target"), { password: wrong }));
    expect(err).toBeInstanceOf(KhError);
    expect((err as KhError).code).toBe("invalid");
    expect((err as Error).message).toContain("密码");
    expect((err as Error).message).not.toContain(password);
    expect((err as Error).message).not.toContain(wrong);
  });
});

describe("列出备份文件", () => {
  it("按创建时间倒序列出文件名匹配的 zip，忽略其他文件", async () => {
    await fs.mkdir(dataDir, { recursive: true });
    // 文件名里的时间用本机时区，这里也用本地时间构造，两个时区下名字都一样
    await writeBackupArchive(dataDir, backupDir, { now: () => new Date(2026, 8, 29, 9, 0, 0) });
    await writeBackupArchive(dataDir, backupDir, { now: () => new Date(2026, 8, 29, 10, 0, 0) });
    await fs.writeFile(path.join(backupDir, "other.zip"), "别的 zip");
    await fs.writeFile(path.join(backupDir, "kanban-hub-20260929-1111.zip"), "名字不合规");
    await fs.mkdir(path.join(backupDir, "kanban-hub-20260929-120000.zip"));

    const list = listBackupFiles(backupDir);
    expect(list.map((b) => b.fileName)).toEqual([
      "kanban-hub-20260929-100000.zip",
      "kanban-hub-20260929-090000.zip",
    ]);
    for (const item of list) {
      expect(item.size).toBeGreaterThan(0);
      expect(item.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it("备份目录不存在时返回空列表", () => {
    expect(listBackupFiles(path.join(root, "没有这个目录"))).toEqual([]);
  });
});

describe("Store 的备份入口", () => {
  it("createBackup 先提交待提交的改动：备份里的 git 历史包含它们", async () => {
    const seeded = await seedData();
    expect(seeded.store.pendingCommitCount()).toBeGreaterThan(0);
    const info = await seeded.store.createBackup({});
    const target = path.join(root, "r");
    await restoreArchive(path.join(backupDir, info.fileName), target);
    const { stdout } = await new GitRepo(target).run(["log", "--format=%s"]);
    expect(stdout).toContain("cli(mac):");
  });

  it("打包期间新的写请求排在备份之后完成，备份里没有排在后面的写入", async () => {
    const seeded = await seedData();
    const pending = seeded.store.createBackup({});
    const { project } = await seeded.store.createProject({ name: "备份期间新建" }, seeded.actor);
    await pending;
    const files = seeded.store.listBackups();
    const zipped = await readZipBytes(path.join(backupDir, files[0]!.fileName));
    expect([...zipped.keys()].some((n) => n.includes(project.id))).toBe(false);

    // 排在备份后面的写入在备份完成后照常生效并提交
    await seeded.store.close();
    const again = await Store.open({ dataDir, commitDebounceMs: 60_000, log: () => {} });
    opened.push(again);
    expect(again.getProject(project.id)?.name).toBe("备份期间新建");
  });

  it("backupRunning 在创建进行中为真，结束之后为假", async () => {
    const seeded = await seedData();
    expect(seeded.store.backupRunning()).toBe(false);
    const pending = seeded.store.createBackup({});
    expect(seeded.store.backupRunning()).toBe(true);
    await pending;
    expect(seeded.store.backupRunning()).toBe(false);
  });

  it("listBackups 列出备份，readBackupFile 读出内容，名字不合规或不存在时报 not_found", async () => {
    const store = await seedData().then((s) => s.store);
    const info = await store.createBackup({});
    expect(store.listBackups().map((b) => b.fileName)).toEqual([info.fileName]);
    const bytes = await store.readBackupFile(info.fileName);
    expect(Buffer.from(bytes.subarray(0, 2)).toString()).toBe("PK");
    await expect(store.readBackupFile("kanban-hub-20991231-000000.zip")).rejects.toMatchObject({ code: "not_found" });
    await expect(store.readBackupFile("../escape.zip")).rejects.toMatchObject({ code: "not_found" });
    await expect(store.readBackupFile("other.zip")).rejects.toMatchObject({ code: "not_found" });
  });

  it("不传 backupDir 时备份写到数据目录旁边的 backups 目录", async () => {
    const store = await Store.open({
      dataDir,
      now: clockFrom("2026-09-28T08:00:00.000Z"),
      commitDebounceMs: 60_000,
      log: () => {},
    });
    opened.push(store);
    await store.createBackup({});
    const files = await fs.readdir(path.join(root, "backups"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(BACKUP_FILE_NAME_RE);
  });

  it("关闭之后拒绝创建备份", async () => {
    const store = await seedData().then((s) => s.store);
    await store.close();
    const err = await rejection(store.createBackup({}));
    expect((err as KhError).code).toBe("unavailable");
  });
});
