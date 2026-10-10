/**
 * 同步忽略规则的端到端测试：内置规则与标记目录、.kanban-hub/ignore、kh sync --dry-run、
 * 多机器之间各自的忽略规则对 kh pull 的影响（多机夹具见 fleet.ts，同步范围是 notes/**）。
 */
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "../server/api/test-server";
import { makeFleet, type Fleet, type Machine } from "./fleet";
import { gitFixture, type RunKhResult } from "./harness";

function expectOk(result: RunKhResult): RunKhResult {
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  return result;
}

describe("同步忽略规则", () => {
  let server: TestServer;
  let fleet: Fleet;
  let A: Machine;

  beforeEach(async () => {
    server = await startTestServer();
    const made = await makeFleet(server);
    fleet = made.fleet;
    A = made.first;
  });

  afterEach(async () => {
    await fleet.cleanup();
    await server.close();
  });

  function snapshotPaths(machine: Machine): string[] {
    const manifest = server.api.store.getSnapshotManifest(fleet.projectId, machine.machineId);
    return (manifest?.files ?? []).map((f) => f.path).sort();
  }

  async function syncedEventCount(): Promise<number> {
    const events = await server.api.store.listEvents({ projectId: fleet.projectId, limit: 100 });
    return events.filter((e) => e.type === "docs.synced").length;
  }

  /** 普通文档、带 pyvenv.cfg 的目录、真实 git init 的嵌套仓库、__pycache__ 四类互不嵌套的内容 */
  async function writeFixtureTree(): Promise<void> {
    await A.write("notes/a.md", "普通文档\n");
    await A.write("notes/pyenv/pyvenv.cfg", "home = /usr/bin\n");
    await A.write("notes/pyenv/lib.py", "x = 1\n");
    await A.write("notes/cache/__pycache__/m.pyc", "pyc");
    await A.write("notes/vendor/inner.md", "嵌套仓库里的文件\n");
    gitFixture(["init", "-q"], path.join(A.repo, "notes", "vendor"));
    gitFixture(["add", "inner.md"], path.join(A.repo, "notes", "vendor"));
    gitFixture(["commit", "-q", "-m", "inner"], path.join(A.repo, "notes", "vendor"));
  }

  it("内置规则与标记目录：快照里只有普通文档，输出提示跳过了 3 个目录", async () => {
    await writeFixtureTree();
    const sync = expectOk(await A.kh(["sync"]));
    expect(snapshotPaths(A)).toEqual(["notes/a.md", "notes/tracked.md"]);
    expect(sync.stdout).toContain("按内置规则跳过了 3 个目录");
    expect(sync.stdout).toContain("kh sync --dry-run");
  });

  it("忽略文件：追加排除的文件从快照消失，! 加回带 pyvenv.cfg 的目录后其中文件出现", async () => {
    await writeFixtureTree();
    await A.write("notes/b.md", "b\n");
    expectOk(await A.kh(["sync"]));
    expect(snapshotPaths(A)).toEqual(["notes/a.md", "notes/b.md", "notes/tracked.md"]);

    await A.write(".kanban-hub/ignore", "notes/b.md\n!notes/pyenv/\n");
    const sync = expectOk(await A.kh(["sync"]));
    expect(snapshotPaths(A)).toEqual(["notes/a.md", "notes/pyenv/lib.py", "notes/pyenv/pyvenv.cfg", "notes/tracked.md"]);
    // 本地文件不动
    expect(await A.exists("notes/b.md")).toBe(true);
    // pyenv 已被加回，只剩嵌套仓库和 __pycache__ 两个
    expect(sync.stdout).toContain("按内置规则跳过了 2 个目录");
  });

  it("kh sync --dry-run：不产生同步事件、不改快照，输出被跳过的目录和文件类型建议", async () => {
    await writeFixtureTree();
    await A.write("notes/data.bin", "bin");
    expectOk(await A.kh(["sync"]));
    const eventsBefore = await syncedEventCount();
    const before = snapshotPaths(A);
    expect(before).toContain("notes/data.bin");

    await A.write("notes/new.md", "新文件\n");
    await A.write("notes/other.bin", "bin2");
    const dry = expectOk(await A.kh(["sync", "--dry-run"]));

    expect(dry.stdout).toContain("将同步");
    expect(dry.stdout).toContain("被跳过的目录");
    expect(dry.stdout).toContain("notes/pyenv");
    expect(dry.stdout).toContain("notes/cache/__pycache__");
    expect(dry.stdout).toContain("文件类型建议");
    expect(dry.stdout).toContain(".bin");
    expect(snapshotPaths(A)).toEqual(before);
    expect(await syncedEventCount()).toBe(eventsBefore);
  });

  describe("多机器", () => {
    let B: Machine;

    beforeEach(async () => {
      B = await fleet.add("机器B");
    });

    it("A 的忽略规则排除的路径不在快照里，B 照常拉取其余文件", async () => {
      await A.write(".kanban-hub/ignore", "notes/draft.md\n");
      await A.write("notes/a.md", "A\n");
      await A.write("notes/draft.md", "草稿\n");
      expectOk(await A.kh(["sync"]));
      expect(snapshotPaths(A)).toEqual(["notes/a.md", "notes/tracked.md"]);

      expectOk(await B.kh(["pull"]));
      expect(await B.read("notes/a.md")).toBe("A\n");
      expect(await B.exists("notes/draft.md")).toBe(false);
    });

    it("B 自己的忽略文件排除了某个路径时，kh pull 不写这个文件", async () => {
      await A.write("notes/a.md", "A\n");
      await A.write("notes/skip.md", "不要拉\n");
      expectOk(await A.kh(["sync"]));
      expect(snapshotPaths(A)).toEqual(["notes/a.md", "notes/skip.md", "notes/tracked.md"]);

      await B.write(".kanban-hub/ignore", "notes/skip.md\n");
      expectOk(await B.kh(["pull"]));
      expect(await B.read("notes/a.md")).toBe("A\n");
      expect(await B.exists("notes/skip.md")).toBe(false);
    });
  });
});

