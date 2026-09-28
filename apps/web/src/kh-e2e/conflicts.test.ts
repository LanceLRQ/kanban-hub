/**
 * kh conflicts / conflicts show / conflicts resolve 的端到端测试（多机夹具见 fleet.ts）。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeRepoConfig } from "../../../../packages/cli/src/repo/config";
import { startTestServer, type TestServer } from "../server/api/test-server";
import { makeFleet, sha, type Fleet, type Machine } from "./fleet";
import type { RunKhResult } from "./harness";

function expectOk(result: RunKhResult): RunKhResult {
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  return result;
}

const BASE = "1\n2\n3\n";
const FROM_A = "1\nA\n3\n";
const FROM_B = "1\nB\n3\n";

describe("kh conflicts", () => {
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

  /** 让 B 在 notes/a.md 上登记一个文本冲突 */
  async function makeTextConflict(): Promise<void> {
    await A.write("notes/a.md", BASE);
    expectOk(await A.kh(["sync"]));
    expectOk(await B.kh(["pull"]));
    await A.write("notes/a.md", FROM_A);
    expectOk(await A.kh(["sync"]));
    await B.write("notes/a.md", FROM_B);
    const pull = expectOk(await B.kh(["pull"]));
    expect(pull.stdout).toContain("冲突");
  }

  it("没有冲突时输出“没有未解决的冲突”；支持 --agent", async () => {
    const result = expectOk(await B.kh(["conflicts"]));
    expect(result.stdout).toContain("没有未解决的冲突");
    expectOk(await B.kh(["conflicts", "--agent", "claude-code"]));
    expect((await B.kh(["conflicts", "--agent", "bad name"])).code).toBe(2);
  });

  it("conflicts show：文本冲突输出 diff3 标记和三个标签，不改本地文件", async () => {
    await makeTextConflict();
    const show = expectOk(await B.kh(["conflicts", "show", "notes/a.md"]));
    expect(show.stdout).toContain("<<<<<<< 本机");
    expect(show.stdout).toContain("||||||| 共同基准");
    expect(show.stdout).toContain("=======");
    expect(show.stdout).toContain(">>>>>>> 机器A");
    expect(await B.read("notes/a.md")).toBe(FROM_B);
  });

  it("conflicts show：二进制冲突输出 git diff --no-index 格式", async () => {
    await A.write("notes/img.bin", Buffer.from([0, 1, 2, 3]));
    expectOk(await A.kh(["sync"]));
    expectOk(await B.kh(["pull"]));
    await A.write("notes/img.bin", Buffer.from([0, 1, 2, 4]));
    expectOk(await A.kh(["sync"]));
    await B.write("notes/img.bin", Buffer.from([0, 1, 2, 5]));
    const pull = expectOk(await B.kh(["pull"]));
    expect(pull.stdout).toContain("notes/img.bin");

    const show = expectOk(await B.kh(["conflicts", "show", "notes/img.bin"]));
    expect(show.stdout).toContain("diff --git");
    expect(show.stdout).toMatch(/Binary files .* differ/);
  });

  it("conflicts show：本地文件已经不存在时，只显示对方版本的信息", async () => {
    await makeTextConflict();
    await B.remove("notes/a.md");
    const show = expectOk(await B.kh(["conflicts", "show", "notes/a.md"]));
    expect(show.stdout).toContain("本地文件已不存在");
    expect(show.stdout).toContain("机器A");
    expect(show.stdout).not.toContain("<<<<<<<");
  });

  it("conflicts show / resolve：路径没有冲突时退出码 2", async () => {
    expect((await B.kh(["conflicts", "show", "notes/none.md"])).code).toBe(2);
    expect((await B.kh(["conflicts", "resolve", "notes/none.md", "--take-local"])).code).toBe(2);
  });

  it("conflicts resolve：必须且只能选一种方式", async () => {
    await makeTextConflict();
    expect((await B.kh(["conflicts", "resolve", "notes/a.md"])).code).toBe(2);
    expect((await B.kh(["conflicts", "resolve", "notes/a.md", "--take-local", "--take-remote"])).code).toBe(2);
  });

  it("resolve --take-remote：本地内容等于对方，基准更新为对方版本，冲突记录删除", async () => {
    await makeTextConflict();
    const result = expectOk(await B.kh(["conflicts", "resolve", "notes/a.md", "--take-remote"]));
    expect(result.stdout).toContain("kh sync");
    expect(await B.read("notes/a.md")).toBe(FROM_A);
    const state = await B.state();
    expect(state.base["notes/a.md"]).toBe(sha(FROM_A));
    expect(state.conflicts["notes/a.md"]).toBeUndefined();
    expect(state.seen["notes/a.md"]).toContain(sha(FROM_A));
    expect((await B.kh(["conflicts"])).stdout).toContain("没有未解决的冲突");
  });

  it("resolve --take-remote：本地路径不安全时不写入（退出码 5），冲突保留", async () => {
    await makeTextConflict();
    await B.remove("notes/a.md");
    await B.write("notes/a.md/inner.md", "now a directory\n");
    const result = await B.kh(["conflicts", "resolve", "notes/a.md", "--take-remote"]);
    expect(result.code).toBe(5);
    expect(await B.read("notes/a.md/inner.md")).toBe("now a directory\n");
    expect((await B.state()).conflicts["notes/a.md"]).toBeDefined();
  });

  it("resolve --take-remote：路径不在本机同步范围内时不写入（退出码 5），提示调整范围或用 --take-local", async () => {
    await makeTextConflict();
    await writeRepoConfig(B.repo, {
      projectId: fleet.projectId,
      sync: { include: ["other/**"], exclude: [], maxFileSize: "5MB" },
      pull: { auto: true },
    });
    const result = await B.kh(["conflicts", "resolve", "notes/a.md", "--take-remote"]);
    expect(result.code).toBe(5);
    expect(result.stderr).toContain("--take-local");
    expect(await B.read("notes/a.md")).toBe(FROM_B);
    expect((await B.state()).conflicts["notes/a.md"]).toBeDefined();
  });

  it("resolve --take-remote：父目录是指向仓库外的软链接时拒绝写入", async () => {
    await A.write("notes/sub/a.md", BASE);
    expectOk(await A.kh(["sync"]));
    expectOk(await B.kh(["pull"]));
    await A.write("notes/sub/a.md", FROM_A);
    expectOk(await A.kh(["sync"]));
    await B.write("notes/sub/a.md", FROM_B);
    expect(expectOk(await B.kh(["pull"])).stdout).toContain("冲突");

    const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "kh-e2e-outside-")));
    try {
      await fs.rm(path.join(B.repo, "notes", "sub"), { recursive: true });
      await fs.symlink(outside, path.join(B.repo, "notes", "sub"));
      const result = await B.kh(["conflicts", "resolve", "notes/sub/a.md", "--take-remote"]);
      expect(result.code).toBe(5);
      expect(await fs.readdir(outside)).toEqual([]);
      expect((await B.state()).conflicts["notes/sub/a.md"]).toBeDefined();
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("resolve --take-local：本地不动，基准更新为对方版本", async () => {
    await makeTextConflict();
    expectOk(await B.kh(["conflicts", "resolve", "notes/a.md", "--take-local"]));
    expect(await B.read("notes/a.md")).toBe(FROM_B);
    const state = await B.state();
    expect(state.base["notes/a.md"]).toBe(sha(FROM_A));
    expect(state.seen["notes/a.md"]).toEqual(expect.arrayContaining([sha(FROM_A), sha(FROM_B)]));
    expect(state.conflicts["notes/a.md"]).toBeUndefined();
  });

  it("resolve --edited：本地文件必须存在；解决后基准更新为对方版本", async () => {
    await makeTextConflict();
    await B.remove("notes/a.md");
    const missing = await B.kh(["conflicts", "resolve", "notes/a.md", "--edited"]);
    expect(missing.code).not.toBe(0);
    expect((await B.state()).conflicts["notes/a.md"]).toBeDefined();

    await B.write("notes/a.md", "1\nA and B\n3\n");
    expectOk(await B.kh(["conflicts", "resolve", "notes/a.md", "--edited"]));
    const state = await B.state();
    expect(state.base["notes/a.md"]).toBe(sha(FROM_A));
    expect(state.conflicts["notes/a.md"]).toBeUndefined();
  });

  it("resolve 之后 kh sync 推送最终内容；A 再拉取得到最终内容（快进），不产生新冲突", async () => {
    await makeTextConflict();
    const final = "1\nA and B\n3\n";
    await B.write("notes/a.md", final);
    expectOk(await B.kh(["conflicts", "resolve", "notes/a.md", "--edited"]));
    expectOk(await B.kh(["sync"]));

    const snapshot = await server.api.store.readSnapshotFile(fleet.projectId, B.machineId, "notes/a.md");
    expect(Buffer.from(snapshot ?? []).toString("utf8")).toBe(final);

    const pullA = expectOk(await A.kh(["pull"]));
    expect(pullA.stdout).toContain("覆盖");
    expect(pullA.stdout).not.toContain("冲突");
    expect(await A.read("notes/a.md")).toBe(final);
    expect((await A.kh(["conflicts"])).stdout).toContain("没有未解决的冲突");

    // B 再拉取：A 的版本已经等于 B 的最终内容，不会再有变化
    const pullB = expectOk(await B.kh(["pull"]));
    expect(pullB.stdout).not.toContain("notes/a.md");
  });
});
