import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type CommitActor, type CommitGit, Committer } from "./committer";
import { GitRepo } from "./git";

const mac: CommitActor = { key: "u1|m1|cli", author: { name: "Alice", email: "u1@kanban-hub.local" }, scope: "cli(mac)" };
const web: CommitActor = { key: "u1||web", author: { name: "Alice", email: "u1@kanban-hub.local" }, scope: "web" };

/** 假的 git：记录每次提交的说明、作者和暂存的文件；failTimes 指定前几次提交失败 */
function fakeGit(failTimes = 0) {
  let staged: string[] = [];
  let failures = failTimes;
  const commits: { message: string; author: string; paths: string[] }[] = [];
  const git: CommitGit = {
    async stageFiles(paths) {
      staged.push(...paths);
    },
    async hasStagedChanges() {
      return staged.length > 0;
    },
    async commit(message, author) {
      if (failures > 0) {
        failures -= 1;
        throw new Error("index.lock 被占用");
      }
      commits.push({ message, author: `${author.name} <${author.email}>`, paths: [...staged].sort() });
      staged = [];
    },
  };
  return { git, commits };
}

function make(git: CommitGit): Committer {
  return new Committer({
    git,
    runExclusive: (job) => job(),
    debounceMs: 30_000,
    retryBaseMs: 5_000,
    retryMaxMs: 60_000,
    log: () => {},
  });
}

const BOARD = "projects/p/board.yaml";
const EVENTS = "projects/p/events/2026-09.jsonl";
const PROJECT = "projects/p/project.yaml";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Committer", () => {
  it("最后一次写入 30 秒后才提交，期间的新写入会重新计时", async () => {
    const { git, commits } = fakeGit();
    const c = make(git);
    await c.track(mac, [BOARD, EVENTS], ["task.status_changed"]);
    await vi.advanceTimersByTimeAsync(20_000);
    await c.track(mac, [BOARD, EVENTS], ["task.status_changed"]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(commits).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(commits).toEqual([
      { message: "cli(mac): 2 项任务状态变更", author: "Alice <u1@kanban-hub.local>", paths: [BOARD, EVENTS] },
    ]);
    expect(c.pendingCount()).toBe(0);
  });

  it("不同操作者、文件不重叠时，按出现顺序各成一个提交", async () => {
    const { git, commits } = fakeGit();
    const c = make(git);
    await c.track(mac, ["projects/a/board.yaml"], ["task.created"]);
    await c.track(web, ["projects/b/project.yaml"], ["project.updated"]);
    expect(await c.flush()).toBe(true);
    expect(commits.map((x) => [x.message, x.paths])).toEqual([
      ["cli(mac): 1 项新建任务", ["projects/a/board.yaml"]],
      ["web: 1 项项目更新", ["projects/b/project.yaml"]],
    ]);
  });

  it("要写的文件有另一个操作者的待提交改动时，写之前先提交已有的改动", async () => {
    const { git, commits } = fakeGit();
    const c = make(git);
    await c.track(mac, [BOARD, EVENTS], ["task.updated"]);
    await c.beforeWrite(web, [PROJECT, EVENTS]);
    expect(commits.map((x) => x.message)).toEqual(["cli(mac): 1 项任务更新"]);
    await c.track(web, [PROJECT, EVENTS], ["project.updated"]);
    await c.flush();
    expect(commits.map((x) => x.message)).toEqual(["cli(mac): 1 项任务更新", "web: 1 项项目更新"]);
    expect(commits[1]!.paths).toEqual([EVENTS, PROJECT]);
  });

  it("写文件前的提前提交失败时，写入照常进行，重试成功后内容全部提交", async () => {
    const { git, commits } = fakeGit(1);
    const c = make(git);
    await c.beforeWrite(mac, [BOARD, EVENTS]);
    await c.track(mac, [BOARD, EVENTS], ["task.updated"]);
    // web 要写同一个事件文件：beforeWrite 触发提前提交，这次提交失败（index.lock 被占用）
    await c.beforeWrite(web, [EVENTS]);
    await c.track(web, [EVENTS], ["log"]);
    expect(commits).toEqual([]);
    expect(c.pendingCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(commits.map((x) => ({ message: x.message, author: x.author }))).toEqual([
      { message: "cli(mac): 1 项任务更新", author: "Alice <u1@kanban-hub.local>" },
    ]);
    expect(c.pendingCount()).toBe(0);
    await c.track(web, [EVENTS], ["project.updated"]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(commits.map((x) => x.message)).toEqual(["cli(mac): 1 项任务更新", "web: 1 项项目更新"]);
    expect(c.pendingCount()).toBe(0);
  });

  it("提交失败时保留待提交的改动，并按 5 秒、10 秒退避重试", async () => {
    const { git, commits } = fakeGit(2);
    const c = make(git);
    await c.track(mac, [BOARD], ["log"]);
    expect(await c.flush()).toBe(false);
    expect(c.pendingCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(commits).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(commits.map((x) => x.message)).toEqual(["cli(mac): 1 项日志"]);
    expect(c.pendingCount()).toBe(0);
  });

  it("处于失败退避时，新的写入不会把重试改回 30 秒", async () => {
    const { git, commits } = fakeGit(1);
    const c = make(git);
    await c.track(mac, [BOARD], ["log"]);
    expect(await c.flush()).toBe(false);
    await c.track(mac, [BOARD], ["log"]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(commits.map((x) => x.message)).toEqual(["cli(mac): 2 项日志"]);
  });

  it("暂存后没有实际改动的组不产生提交", async () => {
    const commit = vi.fn();
    const c = make({ stageFiles: async () => {}, hasStagedChanges: async () => false, commit });
    await c.track(mac, [BOARD], ["log"]);
    expect(await c.flush()).toBe(true);
    expect(commit).not.toHaveBeenCalled();
    expect(c.pendingCount()).toBe(0);
  });

  it("close 之后定时器不再触发", async () => {
    const { git, commits } = fakeGit();
    const c = make(git);
    await c.track(mac, [BOARD], ["log"]);
    c.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(commits).toEqual([]);
  });

  describe("接真实 git", () => {
    beforeEach(() => {
      vi.useRealTimers();
    });

    it("两个操作者各成一个提交，作者分别是各自的用户，提交者是 kanban-hub", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kh-committer-"));
      try {
        const repo = new GitRepo(dir);
        await repo.init();
        const c = new Committer({ git: repo, runExclusive: (job) => job(), log: () => {} });
        const bob: CommitActor = { key: "u2||web", author: { name: "Bob", email: "u2@kanban-hub.local" }, scope: "web" };
        await fs.writeFile(path.join(dir, "a.yaml"), "a");
        await c.track(mac, ["a.yaml"], ["task.created"]);
        await fs.writeFile(path.join(dir, "b.yaml"), "b");
        await c.track(bob, ["b.yaml"], ["log"]);
        expect(await c.flush()).toBe(true);
        c.close();
        const { stdout } = await repo.run(["log", "--format=%an|%cn|%s"]);
        expect(stdout.trim().split("\n")).toEqual(["Bob|kanban-hub|web: 1 项日志", "Alice|kanban-hub|cli(mac): 1 项新建任务"]);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });
});
