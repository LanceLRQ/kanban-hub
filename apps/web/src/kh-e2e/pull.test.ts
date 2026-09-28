/**
 * kh pull 的端到端测试：进程内测试服务端 + 同一个 git 仓库的多个克隆（见 fleet.ts）。
 * 文档放在 .gitignore 忽略的 notes/ 目录下，另有一个强制加入 git 的 notes/tracked.md
 * 用来验证“被 git 跟踪的文件一律跳过”。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireLogin, requireRegisteredRepo } from "../../../../packages/cli/src/commands/shared";
import { writeRepoConfig } from "../../../../packages/cli/src/repo/config";
import { pullDocs } from "../../../../packages/cli/src/sync/pull";
import { openSyncState } from "../../../../packages/cli/src/sync/state";
import { startTestServer, type TestServer } from "../server/api/test-server";
import { makeFleet, sha, type Fleet, type Machine } from "./fleet";
import { makeKhContext, runKh, type RunKhResult } from "./harness";

/** 整个目录的指纹：每个条目的相对路径、类型和内容 hash（软链接取链接目标） */
async function hashTree(dir: string): Promise<string> {
  const lines: string[] = [];
  async function walk(abs: string, rel: string): Promise<void> {
    const entries = await fs.readdir(abs, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      const childAbs = path.join(abs, entry.name);
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) lines.push(`L ${childRel} ${await fs.readlink(childAbs)}`);
      else if (entry.isDirectory()) {
        lines.push(`D ${childRel}`);
        await walk(childAbs, childRel);
      } else lines.push(`F ${childRel} ${sha(await fs.readFile(childAbs))}`);
    }
  }
  await walk(dir, "");
  return sha(lines.join("\n"));
}

async function pulledEvents(server: TestServer, projectId: string) {
  const events = await server.api.store.listEvents({ projectId, limit: 100 });
  return events.filter((e) => e.type === "docs.pulled");
}

function expectOk(result: RunKhResult): RunKhResult {
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  return result;
}

describe("kh pull", () => {
  let server: TestServer;
  let fleet: Fleet;
  let A: Machine;
  let B: Machine;

  beforeEach(async () => {
    server = await startTestServer();
    const made = await makeFleet(server);
    fleet = made.fleet;
    A = made.first;
    B = await fleet.add("机器B");
  });

  afterEach(async () => {
    await fleet.cleanup();
    await server.close();
  });

  describe("写入效果", () => {
    it("新建：A 新增并同步，B 拉取后得到同样的文件（包括多级目录）", async () => {
      await A.write("notes/a.md", "A1\n");
      await A.write("notes/sub/deep/b.md", "deep\n");
      expectOk(await A.kh(["sync"]));

      const pull = expectOk(await B.kh(["pull"]));
      expect(pull.stdout).toContain("新建");
      expect(pull.stdout).toContain("notes/a.md");
      expect(await B.read("notes/a.md")).toBe("A1\n");
      expect(await B.read("notes/sub/deep/b.md")).toBe("deep\n");

      const state = await B.state();
      expect(state.base["notes/a.md"]).toBe(sha("A1\n"));
      // 写入后直接记进 hash 缓存，下次同步不用重新读取计算
      const stat = await fs.stat(path.join(B.repo, "notes", "a.md"));
      expect((state as unknown as { hashCache: Record<string, unknown> }).hashCache["notes/a.md"]).toEqual({
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        sha: sha("A1\n"),
      });
    });

    it("两边内容相同：不动、不列出，基准更新为这份内容，不记事件", async () => {
      await A.write("notes/a.md", "same\n");
      expectOk(await A.kh(["sync"]));
      await B.write("notes/a.md", "same\n");

      const pull = expectOk(await B.kh(["pull"]));
      expect(pull.stdout).not.toContain("notes/a.md");
      expect((await B.state()).base["notes/a.md"]).toBe(sha("same\n"));
      expect(await pulledEvents(server, fleet.projectId)).toHaveLength(0);
    });

    it("记录拉取事件失败时只输出一行警告，拉取结果不受影响（退出码 0）", async () => {
      await A.write("notes/a.md", "A1\n");
      expectOk(await A.kh(["sync"]));
      const failingFetch: typeof fetch = async (input, init) => {
        if (String(input).endsWith("/sync/pulled")) return new Response("boom", { status: 500 });
        return fetch(input, init);
      };
      const result = await runKh(["pull"], { cwd: B.repo, khHome: B.home, fetch: failingFetch });
      expect(result.code).toBe(0);
      expect(result.stderr).toContain("警告");
      expect(result.stderr.trimEnd().split("\n")).toHaveLength(1);
      expect(await B.read("notes/a.md")).toBe("A1\n");
    });

    it("覆盖：B 没改、A 改了，B 拉取后内容等于 A 的", async () => {
      await A.write("notes/a.md", "A1\n");
      expectOk(await A.kh(["sync"]));
      expectOk(await B.kh(["pull"]));

      await A.write("notes/a.md", "A2\n");
      expectOk(await A.kh(["sync"]));
      const pull = expectOk(await B.kh(["pull"]));
      expect(pull.stdout).toContain("覆盖");
      expect(await B.read("notes/a.md")).toBe("A2\n");
    });

    it("自动合并：两边改动不重叠，B 拉取后包含两边的改动；B 推送后 A 拉取直接得到合并结果", async () => {
      await A.write("notes/a.md", "1\n2\n3\n4\n5\n");
      expectOk(await A.kh(["sync"]));
      expectOk(await B.kh(["pull"]));

      await A.write("notes/a.md", "1-A\n2\n3\n4\n5\n");
      expectOk(await A.kh(["sync"]));
      await B.write("notes/a.md", "1\n2\n3\n4\n5-B\n");

      const pull = expectOk(await B.kh(["pull"]));
      expect(pull.stdout).toContain("自动合并");
      expect(pull.stdout).toContain("notes/a.md");
      expect(await B.read("notes/a.md")).toBe("1-A\n2\n3\n4\n5-B\n");
      expect((await B.state()).base["notes/a.md"]).toBe(sha("1-A\n2\n3\n4\n5\n"));

      expectOk(await B.kh(["sync"]));
      const pullA = expectOk(await A.kh(["pull"]));
      expect(pullA.stdout).toContain("覆盖");
      expect(pullA.stdout).not.toContain("冲突");
      expect(await A.read("notes/a.md")).toBe("1-A\n2\n3\n4\n5-B\n");
    });

    it("登记冲突：同一行两边改法不同，B 本地不动，kh conflicts 能列出，最后一行提示 conflicts show", async () => {
      await A.write("notes/a.md", "1\n2\n3\n");
      expectOk(await A.kh(["sync"]));
      expectOk(await B.kh(["pull"]));
      await A.write("notes/a.md", "1\nA\n3\n");
      expectOk(await A.kh(["sync"]));
      await B.write("notes/a.md", "1\nB\n3\n");

      const pull = expectOk(await B.kh(["pull"]));
      expect(pull.stdout).toContain("冲突");
      const lines = pull.stdout.trimEnd().split("\n");
      expect(lines[lines.length - 1]).toContain("kh conflicts show notes/a.md");
      expect(await B.read("notes/a.md")).toBe("1\nB\n3\n");
      // 登记冲突时基准不变
      expect((await B.state()).base["notes/a.md"]).toBe(sha("1\n2\n3\n"));

      const list = expectOk(await B.kh(["conflicts"]));
      expect(list.stdout).toContain("notes/a.md");
      expect(list.stdout).toContain("机器A");

      // 已有冲突的路径再次拉取时跳过，保持冲突
      const again = expectOk(await B.kh(["pull"]));
      expect(again.stdout).not.toContain("notes/a.md");
      expect(await B.read("notes/a.md")).toBe("1\nB\n3\n");
    });

    it("跳过被 git 跟踪的文件：A 快照里有 B 仓库里被 git 跟踪的路径，B 拉取不写它", async () => {
      await A.write("notes/tracked.md", "changed on A\n");
      await A.write("notes/plain.md", "plain\n");
      expectOk(await A.kh(["sync"]));

      const pull = expectOk(await B.kh(["pull"]));
      expect(await B.read("notes/tracked.md")).toBe("tracked in git\n");
      expect(await B.read("notes/plain.md")).toBe("plain\n");
      expect(pull.stdout).toContain("被 git 跟踪");
      expect(pull.stdout).toContain("1 个");
    });

    it("从不删除本地文件：A 删掉文件并同步，B 拉取后文件仍在", async () => {
      await A.write("notes/a.md", "A1\n");
      expectOk(await A.kh(["sync"]));
      expectOk(await B.kh(["pull"]));

      await A.remove("notes/a.md");
      expectOk(await A.kh(["sync"]));
      expectOk(await B.kh(["pull"]));
      expect(await B.read("notes/a.md")).toBe("A1\n");
    });

    it("--dry-run 不写任何东西：仓库和 KH_HOME 前后完全一致，标题写“将要”", async () => {
      // 先让 B 有基准和已有内容，再准备新建、覆盖、自动合并、冲突四种情况
      await A.write("notes/over.md", "o1\n");
      await A.write("notes/merge.md", "1\n2\n3\n4\n5\n");
      await A.write("notes/conflict.md", "1\n2\n3\n");
      expectOk(await A.kh(["sync"]));
      expectOk(await B.kh(["pull"]));

      await A.write("notes/new.md", "new\n");
      await A.write("notes/over.md", "o2\n");
      await A.write("notes/merge.md", "1-A\n2\n3\n4\n5\n");
      await A.write("notes/conflict.md", "1\nA\n3\n");
      expectOk(await A.kh(["sync"]));
      await B.write("notes/merge.md", "1\n2\n3\n4\n5-B\n");
      await B.write("notes/conflict.md", "1\nB\n3\n");

      const repoBefore = await hashTree(B.repo);
      const homeBefore = await hashTree(B.home);
      const dry = expectOk(await B.kh(["pull", "--dry-run"]));
      expect(await hashTree(B.repo)).toBe(repoBefore);
      expect(await hashTree(B.home)).toBe(homeBefore);

      expect(dry.stdout).toContain("将要新建");
      expect(dry.stdout).toContain("将要覆盖");
      expect(dry.stdout).toContain("将要自动合并");
      expect(dry.stdout).toContain("将要登记冲突");
      expect(dry.stdout).toContain("notes/new.md");
      expect(dry.stdout).toContain("notes/merge.md");
      expect(dry.stdout).toContain("notes/conflict.md");
      expect(await pulledEvents(server, fleet.projectId)).toHaveLength(1); // 只有第一次真实拉取的那一条
    });
  });

  describe("逐文件判定", () => {
    it("不会静默覆盖：A、B 都从 X 出发，A 改成 Y 推送，B 改成 Z 推送，A 拉取后不是 Z", async () => {
      await A.write("notes/a.md", "X1\nX2\nX3\nX4\nX5\n");
      expectOk(await A.kh(["sync"]));
      expectOk(await B.kh(["pull"]));

      await A.write("notes/a.md", "Y1\nX2\nX3\nX4\nX5\n");
      expectOk(await A.kh(["sync"]));
      await B.write("notes/a.md", "X1\nX2\nX3\nX4\nZ5\n");
      expectOk(await B.kh(["sync"]));

      const pull = expectOk(await A.kh(["pull"]));
      expect(await A.read("notes/a.md")).not.toBe("X1\nX2\nX3\nX4\nZ5\n");
      // A 从来没有拉取过这个文件，推送又不改基准，所以 A 没有基准：两边都改了、没有共同基准，
      // 登记冲突，本地保持 Y
      expect(pull.stdout).toContain("冲突");
      expect(await A.read("notes/a.md")).toBe("Y1\nX2\nX3\nX4\nX5\n");
    });

    it("不会静默覆盖（A 有基准时）：A 快进到 B 的版本后，两边各自改了不重叠的地方并推送，A 拉取后自动合并", async () => {
      await A.write("notes/a.md", "X1\nX2\nX3\nX4\nX5\n");
      expectOk(await A.kh(["sync"]));
      expectOk(await B.kh(["pull"]));
      await B.write("notes/a.md", "X1\nX2\nX3\nX4\nX5\nB6\n");
      expectOk(await B.kh(["sync"]));
      expectOk(await A.kh(["pull"])); // 快进：A 的基准变成 B 的这个版本

      await A.write("notes/a.md", "Y1\nX2\nX3\nX4\nX5\nB6\n");
      expectOk(await A.kh(["sync"]));
      await B.write("notes/a.md", "X1\nX2\nX3\nX4\nZ5\nB6\n");
      expectOk(await B.kh(["sync"]));

      const pull = expectOk(await A.kh(["pull"]));
      expect(pull.stdout).toContain("自动合并");
      expect(await A.read("notes/a.md")).toBe("Y1\nX2\nX3\nX4\nZ5\nB6\n");
    });

    it("快进：B 在 A 的版本上继续改，A 拉取后直接得到 B 的版本，不产生冲突", async () => {
      await A.write("notes/a.md", "v1\n");
      expectOk(await A.kh(["sync"]));
      expectOk(await B.kh(["pull"]));
      await B.write("notes/a.md", "v2 from B\n");
      expectOk(await B.kh(["sync"]));

      const pull = expectOk(await A.kh(["pull"]));
      expect(pull.stdout).toContain("覆盖");
      expect(pull.stdout).not.toContain("冲突");
      expect(await A.read("notes/a.md")).toBe("v2 from B\n");
    });

    it("旧版本：第三台机器推送旧内容，B 不被退回；第二次拉取不再列出，也不再记事件", async () => {
      const C = await fleet.add("机器C");
      await A.write("notes/a.md", "X\n");
      expectOk(await A.kh(["sync"]));
      expectOk(await B.kh(["pull"]));
      expectOk(await C.kh(["pull"]));

      await A.write("notes/a.md", "Y\n");
      expectOk(await A.kh(["sync"]));
      expectOk(await B.kh(["pull"]));
      expect(await B.read("notes/a.md")).toBe("Y\n");

      // C 还停在 X，现在才第一次推送：它的 X 成了“最新”的对方版本
      expectOk(await C.kh(["sync"]));
      const before = (await pulledEvents(server, fleet.projectId)).length;

      const first = expectOk(await B.kh(["pull"]));
      expect(await B.read("notes/a.md")).toBe("Y\n");
      expect(first.stdout).toContain("跳过旧版本");
      expect(first.stdout).toContain("notes/a.md");
      const afterFirst = await pulledEvents(server, fleet.projectId);
      expect(afterFirst).toHaveLength(before + 1);

      const second = expectOk(await B.kh(["pull"]));
      expect(second.stdout).not.toContain("notes/a.md");
      expect(await pulledEvents(server, fleet.projectId)).toHaveLength(before + 1);
    });

    it("本地删除：B 删掉拉取来的文件，A 没有新改动时，B 拉取后文件不会回来；A 再改就重新新建", async () => {
      await A.write("notes/a.md", "A1\n");
      expectOk(await A.kh(["sync"]));
      expectOk(await B.kh(["pull"]));
      await B.remove("notes/a.md");

      expectOk(await B.kh(["pull"]));
      expect(await B.exists("notes/a.md")).toBe(false);

      await A.write("notes/a.md", "A2\n");
      expectOk(await A.kh(["sync"]));
      expectOk(await B.kh(["pull"]));
      expect(await B.read("notes/a.md")).toBe("A2\n");
    });

    it("事件：没有变化的拉取不产生 docs.pulled，有变化的产生一条且计数正确", async () => {
      await A.write("notes/new.md", "n\n");
      await A.write("notes/over.md", "o1\n");
      await A.write("notes/merge.md", "1\n2\n3\n4\n5\n");
      await A.write("notes/conflict.md", "1\n2\n3\n");
      expectOk(await A.kh(["sync"]));
      expectOk(await B.kh(["pull"]));
      const events1 = await pulledEvents(server, fleet.projectId);
      expect(events1).toHaveLength(1);
      expect(events1[0]!.change).toMatchObject({
        created: { to: 4 },
        overwritten: { to: 0 },
        merged: { to: 0 },
        conflicts: { to: 0 },
        stale: { to: 0 },
        from: { to: [A.machineId] },
      });

      expectOk(await B.kh(["pull"]));
      expect(await pulledEvents(server, fleet.projectId)).toHaveLength(1);

      await A.write("notes/over.md", "o2\n");
      await A.write("notes/merge.md", "1-A\n2\n3\n4\n5\n");
      await A.write("notes/conflict.md", "1\nA\n3\n");
      await A.write("notes/another.md", "another\n");
      expectOk(await A.kh(["sync"]));
      await B.write("notes/merge.md", "1\n2\n3\n4\n5-B\n");
      await B.write("notes/conflict.md", "1\nB\n3\n");
      expectOk(await B.kh(["pull"]));

      const events2 = await pulledEvents(server, fleet.projectId);
      expect(events2).toHaveLength(2);
      const latest = events2.find((e) => e.id !== events1[0]!.id)!;
      expect(latest.change).toMatchObject({
        created: { to: 1 },
        overwritten: { to: 1 },
        merged: { to: 1 },
        conflicts: { to: 1 },
        stale: { to: 0 },
      });
    });

    it("其他机器都没有快照：退出码 5（包括只有本机自己同步过的情况）", async () => {
      const none = await B.kh(["pull"]);
      expect(none.code).toBe(5);

      await B.write("notes/b.md", "b\n");
      expectOk(await B.kh(["sync"]));
      const onlySelf = await B.kh(["pull"]);
      expect(onlySelf.code).toBe(5);
    });

    it("--path 只处理匹配的路径；--from 只看指定机器", async () => {
      const C = await fleet.add("机器C");
      await A.write("notes/a.md", "a\n");
      await A.write("notes/keep/k.md", "k\n");
      expectOk(await A.kh(["sync"]));
      await C.write("notes/c.md", "c\n");
      expectOk(await C.kh(["sync"]));

      expectOk(await B.kh(["pull", "--path", "notes/keep/**"]));
      expect(await B.read("notes/keep/k.md")).toBe("k\n");
      expect(await B.exists("notes/a.md")).toBe(false);
      expect(await B.exists("notes/c.md")).toBe(false);

      expectOk(await B.kh(["pull", "--from", "机器C"]));
      expect(await B.read("notes/c.md")).toBe("c\n");
      expect(await B.exists("notes/a.md")).toBe(false);
    });

    it("不在本机同步范围内的路径不拉取", async () => {
      await writeRepoConfig(A.repo, {
        projectId: fleet.projectId,
        sync: { include: ["notes/**", "extra/**"], exclude: [], maxFileSize: "5MB" },
        pull: { auto: true },
      });
      await A.write("extra/x.md", "x\n");
      await A.write("notes/a.md", "a\n");
      expectOk(await A.kh(["sync"]));

      expectOk(await B.kh(["pull"]));
      expect(await B.exists("extra/x.md")).toBe(false);
      expect(await B.read("notes/a.md")).toBe("a\n");
    });
  });

  describe("安全", () => {
    it("父目录是指向仓库外的软链接：不经过它写入，计为不安全", async () => {
      const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "kh-e2e-outside-")));
      try {
        await A.write("notes/linked/x.md", "x\n");
        await A.write("notes/ok.md", "ok\n");
        expectOk(await A.kh(["sync"]));

        await fs.mkdir(path.join(B.repo, "notes"), { recursive: true });
        await fs.symlink(outside, path.join(B.repo, "notes", "linked"));
        const pull = expectOk(await B.kh(["pull"]));
        expect(await fs.readdir(outside)).toEqual([]);
        expect(await B.read("notes/ok.md")).toBe("ok\n");
        expect(pull.stdout).toContain("不安全");
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    });

    it("本地同名路径是目录：跳过", async () => {
      await A.write("notes/d.md", "file on A\n");
      expectOk(await A.kh(["sync"]));
      await fs.mkdir(path.join(B.repo, "notes", "d.md"), { recursive: true });

      const pull = expectOk(await B.kh(["pull"]));
      expect((await fs.lstat(path.join(B.repo, "notes", "d.md"))).isDirectory()).toBe(true);
      expect(pull.stdout).toContain("不安全");
    });
  });

  describe("中途失败", () => {
    /** 包一层 fetch：下载某个快照文件时交给 handler 处理，其余请求照常 */
    function interceptFile(filePath: string, handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch {
      return async (input, init) => {
        if (decodeURIComponent(String(input)).endsWith(`/files/${filePath}`)) return handler(input, init);
        return fetch(input, init);
      };
    }

    it("处理到一半下载失败：已写入的文件、状态文件、docs.pulled 计数三者一致，已完成的部分照常输出", async () => {
      await A.write("notes/1.md", "one\n");
      await A.write("notes/2.md", "two\n");
      await A.write("notes/3.md", "three\n");
      expectOk(await A.kh(["sync"]));

      const failing = interceptFile("notes/2.md", async () => {
        throw new TypeError("fetch failed");
      });
      const result = await runKh(["pull"], { cwd: B.repo, khHome: B.home, fetch: failing });
      expect(result.code).toBe(4);
      expect(result.stdout).toContain("拉取中途出错");
      expect(result.stdout).toContain("notes/1.md");

      expect(await B.read("notes/1.md")).toBe("one\n");
      expect(await B.exists("notes/2.md")).toBe(false);
      expect(await B.exists("notes/3.md")).toBe(false);
      const state = await B.state();
      expect(Object.keys(state.base)).toEqual(["notes/1.md"]);
      expect(state.base["notes/1.md"]).toBe(sha("one\n"));
      const events = await pulledEvents(server, fleet.projectId);
      expect(events).toHaveLength(1);
      expect(events[0]!.change).toMatchObject({ created: { to: 1 }, from: { to: [A.machineId] } });

      // 再拉一次补上剩下的，已写入的文件不重复计数
      const again = expectOk(await B.kh(["pull"]));
      expect(again.stdout).not.toContain("notes/1.md");
      expect(await B.read("notes/3.md")).toBe("three\n");
      const events2 = await pulledEvents(server, fleet.projectId);
      expect(events2).toHaveLength(2);
      expect(events2.find((e) => e.id !== events[0]!.id)!.change).toMatchObject({ created: { to: 2 } });
    });

    it("下载到的对方内容与清单 hash 不符：只跳过这个文件并提示，其余照常", async () => {
      await A.write("notes/1.md", "one\n");
      await A.write("notes/2.md", "two\n");
      await A.write("notes/3.md", "three\n");
      expectOk(await A.kh(["sync"]));

      const tampered = interceptFile("notes/2.md", async () => {
        const body = "newer content\n";
        return new Response(body, { status: 200, headers: { "X-KH-Sha256": sha(body) } });
      });
      const result = await runKh(["pull"], { cwd: B.repo, khHome: B.home, fetch: tampered });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("对方在拉取过程中更新了这些文件");
      expect(result.stdout).toContain("notes/2.md");
      expect(await B.read("notes/1.md")).toBe("one\n");
      expect(await B.read("notes/3.md")).toBe("three\n");
      expect(await B.exists("notes/2.md")).toBe(false);
      expect((await B.state()).base["notes/2.md"]).toBeUndefined();
      const events = await pulledEvents(server, fleet.projectId);
      expect(events[0]!.change).toMatchObject({ created: { to: 2 } });
    });

    it("写入前复查发现本地文件刚被改动：不覆盖，计为不安全跳过", async () => {
      await A.write("notes/a.md", "A1\n");
      expectOk(await A.kh(["sync"]));
      expectOk(await B.kh(["pull"]));
      await A.write("notes/a.md", "A2\n");
      expectOk(await A.kh(["sync"]));

      // 判定之后、写入之前，用户把本地文件改掉了
      const racing = interceptFile("notes/a.md", async (input, init) => {
        await B.write("notes/a.md", "edited meanwhile on B\n");
        return fetch(input, init);
      });
      const result = await runKh(["pull"], { cwd: B.repo, khHome: B.home, fetch: racing });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("路径不安全、已跳过：1 个");
      expect(await B.read("notes/a.md")).toBe("edited meanwhile on B\n");
      expect((await B.state()).base["notes/a.md"]).toBe(sha("A1\n"));
    });

    it("旧版本的首次报告不会因为采纳基准时下载失败而丢失", async () => {
      const C = await fleet.add("机器C");
      // B 新建 X 并推送（B 有 seen、没有基准），C 拉到 X；B 再改成 Y 推送
      await B.write("notes/a.md", "X\n");
      expectOk(await B.kh(["sync"]));
      expectOk(await C.kh(["pull"]));
      await B.write("notes/a.md", "Y\n");
      expectOk(await B.kh(["sync"]));
      // C 这才第一次推送 X：对 B 来说是见过的旧版本，而 B 没有基准，需要下载 X 采纳为基准
      expectOk(await C.kh(["sync"]));

      const failing = interceptFile("notes/a.md", async () => {
        throw new TypeError("fetch failed");
      });
      const failed = await runKh(["pull", "--from", "机器C"], { cwd: B.repo, khHome: B.home, fetch: failing });
      expect(failed.code).toBe(4);
      expect((await B.state()).staleReported["notes/a.md"]).toBeUndefined();

      const ok = expectOk(await B.kh(["pull", "--from", "机器C"]));
      expect(ok.stdout).toContain("跳过旧版本");
      expect(await B.read("notes/a.md")).toBe("Y\n");
      expect((await B.state()).base["notes/a.md"]).toBe(sha("X\n"));
      const events = await pulledEvents(server, fleet.projectId);
      const staleEvent = events.find((e) => (e.change as Record<string, { to: unknown }>).stale?.to === 1);
      // 被跳过的旧版本没有被取用，不计入来源机器
      expect(staleEvent?.change).toMatchObject({ stale: { to: 1 }, from: { to: [] } });
    });
  });

  describe("截止时间", () => {
    it("已经过去的 deadline：timedOut 为 true，没有写入任何文件，状态文件仍然有效", async () => {
      await A.write("notes/a.md", "a\n");
      expectOk(await A.kh(["sync"]));

      const { ctx } = makeKhContext({ cwd: B.repo, khHome: B.home });
      const repo = await requireRegisteredRepo(ctx);
      const { client } = await requireLogin(ctx);
      const result = await pullDocs(ctx, repo, client, { dryRun: false, deadline: Date.now() - 1000 });
      expect(result.timedOut).toBe(true);
      expect(result.created).toEqual([]);
      expect(await B.exists("notes/a.md")).toBe(false);

      await expect(openSyncState(ctx, fleet.projectId, repo.root)).resolves.toBeDefined();
      // 之后正常拉取不受影响
      expectOk(await B.kh(["pull"]));
      expect(await B.read("notes/a.md")).toBe("a\n");
    });
  });
});
