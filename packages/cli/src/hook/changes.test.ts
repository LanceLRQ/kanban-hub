import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupDir, fakeContext, gitFixture, makeTempDir } from "../repo/test-helpers";
import { snapshotRepoChanges } from "./changes";

const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) await cleanupDir(dir);
  }
});

async function tempDir(): Promise<string> {
  const dir = await makeTempDir();
  dirs.push(dir);
  return dir;
}

describe("snapshotRepoChanges", () => {
  it("不是 git 仓库：head、dirty 都是 null", async () => {
    const dir = await tempDir();
    const ctx = fakeContext();
    const result = await snapshotRepoChanges(ctx, dir);
    expect(result).toEqual({ head: null, dirty: null });
  });

  it("干净的仓库：head 是提交 hash，dirty 是确定的摘要", async () => {
    const dir = await tempDir();
    gitFixture(["init", "-q"], dir);
    gitFixture(["commit", "-q", "--allow-empty", "-m", "init"], dir);
    const head = gitFixture(["rev-parse", "HEAD"], dir).trim();

    const ctx = fakeContext();
    const result = await snapshotRepoChanges(ctx, dir);
    expect(result.head).toBe(head);
    expect(result.dirty).toMatch(/^[0-9a-f]{64}$/);
  });

  it("新提交改变 head，dirty 不受影响（工作区仍干净）", async () => {
    const dir = await tempDir();
    gitFixture(["init", "-q"], dir);
    gitFixture(["commit", "-q", "--allow-empty", "-m", "init"], dir);
    const before = await snapshotRepoChanges(fakeContext(), dir);

    gitFixture(["commit", "-q", "--allow-empty", "-m", "second"], dir);
    const after = await snapshotRepoChanges(fakeContext(), dir);

    expect(after.head).not.toBe(before.head);
    expect(after.dirty).toBe(before.dirty);
  });

  it("修改一个已跟踪文件：dirty 改变", async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, "tracked.txt"), "first");
    gitFixture(["init", "-q"], dir);
    gitFixture(["add", "tracked.txt"], dir);
    gitFixture(["commit", "-q", "-m", "init"], dir);
    const before = await snapshotRepoChanges(fakeContext(), dir);

    await fs.writeFile(path.join(dir, "tracked.txt"), "second");
    const after = await snapshotRepoChanges(fakeContext(), dir);

    expect(after.dirty).not.toBe(before.dirty);
  });

  it("新增一个未跟踪文件：dirty 改变", async () => {
    const dir = await tempDir();
    gitFixture(["init", "-q"], dir);
    gitFixture(["commit", "-q", "--allow-empty", "-m", "init"], dir);
    const before = await snapshotRepoChanges(fakeContext(), dir);

    await fs.writeFile(path.join(dir, "untracked.txt"), "new");
    const after = await snapshotRepoChanges(fakeContext(), dir);

    expect(after.dirty).not.toBe(before.dirty);
  });

  it("会话开始前已经改过的文件再改一次：dirty 也变（哪怕 git status 里的状态字符没变）", async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, "tracked.txt"), "first");
    gitFixture(["init", "-q"], dir);
    gitFixture(["add", "tracked.txt"], dir);
    gitFixture(["commit", "-q", "-m", "init"], dir);
    await fs.writeFile(path.join(dir, "tracked.txt"), "second");
    const started = await snapshotRepoChanges(fakeContext(), dir);

    // 等一点时间保证 mtime 会变化，再次修改（内容长度相同，git status 里仍是 " M tracked.txt"）
    await new Promise((resolve) => setTimeout(resolve, 20));
    await fs.writeFile(path.join(dir, "tracked.txt"), "THIRDX");
    const again = await snapshotRepoChanges(fakeContext(), dir);

    expect(again.dirty).not.toBe(started.dirty);
  });

  it("改被忽略的文件：dirty 不变", async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, ".gitignore"), "ignored.txt\n");
    gitFixture(["init", "-q"], dir);
    gitFixture(["add", ".gitignore"], dir);
    gitFixture(["commit", "-q", "-m", "init"], dir);
    const before = await snapshotRepoChanges(fakeContext(), dir);

    await fs.writeFile(path.join(dir, "ignored.txt"), "x");
    const after = await snapshotRepoChanges(fakeContext(), dir);

    expect(after.dirty).toBe(before.dirty);
  });

  it("路径含空格和中文：不报错，正确纳入 dirty 的计算", async () => {
    const dir = await tempDir();
    gitFixture(["init", "-q"], dir);
    gitFixture(["commit", "-q", "--allow-empty", "-m", "init"], dir);
    const before = await snapshotRepoChanges(fakeContext(), dir);

    await fs.writeFile(path.join(dir, "带 空格 的 中文名.txt"), "x");
    const after = await snapshotRepoChanges(fakeContext(), dir);

    expect(after.dirty).not.toBe(before.dirty);
  });
});
