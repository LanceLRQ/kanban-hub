import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT } from "../errors";
import { fakeContext } from "../repo/test-helpers";
import { openSyncState } from "./state";

const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) await fs.rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

describe("openSyncState", () => {
  it("hashOf：size 和 mtime 都不变时不重新读文件", async () => {
    const home = await tempDir("kh-state-home-");
    const repo = await tempDir("kh-state-repo-");
    const filePath = path.join(repo, "a.md");
    await fs.writeFile(filePath, "hello world"); // 11 字节
    const stat = await fs.stat(filePath);
    const ref = { path: "a.md", size: stat.size, mtimeMs: stat.mtimeMs, absPath: filePath };

    const ctx = fakeContext({ env: { KH_HOME: home } });
    const state = await openSyncState(ctx, "p000000001", repo);
    const shaFirst = await state.hashOf(ref);

    // 直接在磁盘上换成不同内容（保持同样的字节数），但传给 hashOf 的 size/mtimeMs 仍是第一次
    // 那组值：如果命中缓存不重新读文件，第二次调用应该仍然返回第一次算出来的 hash——即使它
    // 已经和文件的真实内容对不上。文件系统的 mtime 精度不保证能被 utimes 精确复原，所以这里
    // 不依赖重新 stat，而是直接复用同一个 ref 对象来控制“size/mtime 都不变”这个前提条件。
    await fs.writeFile(filePath, "HELLO WORLD"); // 同样 11 字节
    const shaSecond = await state.hashOf(ref);
    expect(shaSecond).toBe(shaFirst);
  });

  it("recordHash：记下的 size、mtime、hash 之后被 hashOf 直接命中，保存后重新打开仍在", async () => {
    const home = await tempDir("kh-state-home-");
    const repo = await tempDir("kh-state-repo-");
    const filePath = path.join(repo, "a.md");
    await fs.writeFile(filePath, "real content");
    const ctx = fakeContext({ env: { KH_HOME: home } });
    const state = await openSyncState(ctx, "p000000001", repo);
    state.recordHash("a.md", 12, 1234, SHA_A);
    expect(await state.hashOf({ path: "a.md", size: 12, mtimeMs: 1234, absPath: filePath })).toBe(SHA_A);
    await state.save();

    const reopened = await openSyncState(ctx, "p000000001", repo);
    expect(await reopened.hashOf({ path: "a.md", size: 12, mtimeMs: 1234, absPath: filePath })).toBe(SHA_A);
  });

  it("hashOf：size 或 mtime 变化时重新计算", async () => {
    const home = await tempDir("kh-state-home-");
    const repo = await tempDir("kh-state-repo-");
    const filePath = path.join(repo, "a.md");
    await fs.writeFile(filePath, "hello");
    const stat1 = await fs.stat(filePath);
    const ctx = fakeContext({ env: { KH_HOME: home } });
    const state = await openSyncState(ctx, "p000000001", repo);

    const sha1 = await state.hashOf({ path: "a.md", size: stat1.size, mtimeMs: stat1.mtimeMs, absPath: filePath });

    await fs.writeFile(filePath, "hello!!");
    const stat2 = await fs.stat(filePath);
    const sha2 = await state.hashOf({ path: "a.md", size: stat2.size, mtimeMs: stat2.mtimeMs, absPath: filePath });
    expect(sha2).not.toBe(sha1);
  });

  it("save 之后重新打开，base/seen/conflicts/staleReported/hashCache 内容一致", async () => {
    const home = await tempDir("kh-state-home-");
    const repo = await tempDir("kh-state-repo-");
    const filePath = path.join(repo, "a.md");
    await fs.writeFile(filePath, "hello");
    const stat = await fs.stat(filePath);
    const ref = { path: "a.md", size: stat.size, mtimeMs: stat.mtimeMs, absPath: filePath };

    const ctx = fakeContext({ env: { KH_HOME: home } });
    const state = await openSyncState(ctx, "p000000001", repo);
    const sha = await state.hashOf(ref);
    state.base.set("a.md", sha);
    state.seen.set("a.md", [sha, SHA_A]);
    state.conflicts.set("b.md", { remoteSha: SHA_B, remoteMachineId: "m000000001", baseSha: SHA_A, detectedAt: "2026-01-01T00:00:00.000Z" });
    state.staleReported.set("c.md", SHA_C);
    await state.save();

    const reopened = await openSyncState(ctx, "p000000001", repo);
    expect(reopened.base.get("a.md")).toBe(sha);
    expect(reopened.seen.get("a.md")).toEqual([sha, SHA_A]);
    expect(reopened.conflicts.get("b.md")).toEqual({
      remoteSha: SHA_B,
      remoteMachineId: "m000000001",
      baseSha: SHA_A,
      detectedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(reopened.staleReported.get("c.md")).toBe(SHA_C);

    // hash 缓存也保留了：同一个 ref 再次 hashOf 不应该抛错，且结果一致（仓库根没变）
    await expect(reopened.hashOf(ref)).resolves.toBe(sha);
  });

  it("仓库根变化时丢弃 hash 缓存，但保留基准", async () => {
    const home = await tempDir("kh-state-home-");
    const repoA = await tempDir("kh-state-repo-a-");
    const filePathA = path.join(repoA, "a.md");
    await fs.writeFile(filePathA, "AAAAA"); // 5 字节

    const ctx = fakeContext({ env: { KH_HOME: home } });
    const state = await openSyncState(ctx, "p000000001", repoA);
    // 用人为选定的 size/mtimeMs（不依赖真实 stat）驱动缓存写入，方便下面在另一个仓库根下
    // 精确构造出“size、mtimeMs 都相同，但内容不同”的对照组
    const refA = { path: "a.md", size: 5, mtimeMs: 1_700_000_000_000, absPath: filePathA };
    const shaA = await state.hashOf(refA);
    state.base.set("a.md", shaA);
    await state.save();

    const repoB = await tempDir("kh-state-repo-b-");
    const filePathB = path.join(repoB, "a.md");
    await fs.writeFile(filePathB, "BBBBB"); // 同样 5 字节，内容不同
    const reopened = await openSyncState(ctx, "p000000001", repoB);
    expect(reopened.base.get("a.md")).toBe(shaA); // 基准保留

    // hash 缓存已经因为仓库根变化被丢弃：即使 size/mtimeMs 与刚才缓存的键完全一样，也必须
    // 重新读取磁盘内容，而不是把 repoA 算出来的 shaA 错误地当成 repoB 这份文件的 hash
    const refB = { path: "a.md", size: 5, mtimeMs: 1_700_000_000_000, absPath: filePathB };
    const shaB = await reopened.hashOf(refB);
    expect(shaB).not.toBe(shaA);
  });

  it("gcBlobs 只删除不再被 base 或 conflicts 引用的 blob", async () => {
    const home = await tempDir("kh-state-home-");
    const repo = await tempDir("kh-state-repo-");
    const ctx = fakeContext({ env: { KH_HOME: home } });
    const state = await openSyncState(ctx, "p000000001", repo);

    await state.putBlob(SHA_A, new Uint8Array([1]));
    await state.putBlob(SHA_B, new Uint8Array([2]));
    await state.putBlob(SHA_C, new Uint8Array([3]));
    state.base.set("a.md", SHA_A);
    state.conflicts.set("b.md", { remoteSha: SHA_B, remoteMachineId: "m000000001", baseSha: null, detectedAt: "2026-01-01T00:00:00.000Z" });
    // SHA_C 没有被任何地方引用

    await state.gcBlobs();

    expect(await state.readBlob(SHA_A)).toEqual(Buffer.from([1]));
    expect(await state.readBlob(SHA_B)).toEqual(Buffer.from([2]));
    expect(await state.readBlob(SHA_C)).toBeNull();
  });

  it("readBlob：不存在的 blob 返回 null", async () => {
    const home = await tempDir("kh-state-home-");
    const repo = await tempDir("kh-state-repo-");
    const ctx = fakeContext({ env: { KH_HOME: home } });
    const state = await openSyncState(ctx, "p000000001", repo);
    expect(await state.readBlob(SHA_A)).toBeNull();
  });

  it("state.json 损坏（不是合法 JSON）时报错退出，退出码 1", async () => {
    const home = await tempDir("kh-state-home-");
    const repo = await tempDir("kh-state-repo-");
    const dir = path.join(home, "cache", "p000000001");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "state.json"), "{not json");

    const ctx = fakeContext({ env: { KH_HOME: home } });
    await expect(openSyncState(ctx, "p000000001", repo)).rejects.toMatchObject({
      name: "CliError",
      exitCode: EXIT.UNEXPECTED,
    });
  });

  it("state.json 损坏（不符合格式）时报错退出，提示删除缓存目录", async () => {
    const home = await tempDir("kh-state-home-");
    const repo = await tempDir("kh-state-repo-");
    const dir = path.join(home, "cache", "p000000001");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "state.json"), JSON.stringify({ root: repo, base: { "a.md": "not-a-sha" } }));

    const ctx = fakeContext({ env: { KH_HOME: home } });
    const err = await openSyncState(ctx, "p000000001", repo).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "CliError", exitCode: EXIT.UNEXPECTED });
    expect((err as { hint?: string }).hint).toContain(dir);
  });
});

describe("openSyncState：lastPush", () => {
  it("没有 lastPush 的旧状态文件照常读取，lastPush 为 null", async () => {
    const home = await tempDir("kh-state-home-");
    const repo = await tempDir("kh-state-repo-");
    const dir = path.join(home, "cache", "p000000001");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "state.json"), JSON.stringify({ root: repo, base: { "a.md": SHA_A } }));
    const state = await openSyncState(fakeContext({ env: { KH_HOME: home } }), "p000000001", repo);
    expect(state.lastPush).toBeNull();
    expect(state.base.get("a.md")).toBe(SHA_A);
  });

  it("设置后保存，重新打开仍在", async () => {
    const home = await tempDir("kh-state-home-");
    const repo = await tempDir("kh-state-repo-");
    const ctx = fakeContext({ env: { KH_HOME: home } });
    const state = await openSyncState(ctx, "p000000001", repo);
    state.lastPush = { at: "2026-09-29T00:00:00.000Z", digest: SHA_B };
    await state.save();
    const reopened = await openSyncState(ctx, "p000000001", repo);
    expect(reopened.lastPush).toEqual({ at: "2026-09-29T00:00:00.000Z", digest: SHA_B });
  });
});
