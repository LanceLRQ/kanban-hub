import { afterEach, describe, expect, it } from "vitest";
import { cleanupDir, gitFixture, makeTempDir } from "./test-helpers";
import { fingerprint } from "./fingerprint";

describe("fingerprint", () => {
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

  it("不是 git 仓库时为 null", async () => {
    const dir = await tempDir();
    expect(await fingerprint(dir)).toBeNull();
  });

  it("没有提交时为 null", async () => {
    const dir = await tempDir();
    gitFixture(["init", "-q"], dir);
    expect(await fingerprint(dir)).toBeNull();
  });

  it("单个根提交时返回它自己的 hash", async () => {
    const dir = await tempDir();
    gitFixture(["init", "-q"], dir);
    gitFixture(["commit", "--allow-empty", "-q", "-m", "init"], dir);
    const hash = gitFixture(["rev-parse", "HEAD"], dir).trim();
    expect(await fingerprint(dir)).toBe(hash);
  });

  it("合并两段无关历史时，取两个根提交里排序后的第一个", async () => {
    const dir = await tempDir();
    gitFixture(["init", "-q"], dir);

    gitFixture(["checkout", "-q", "--orphan", "branch-a"], dir);
    gitFixture(["commit", "-q", "--allow-empty", "-m", "a"], dir);
    const hashA = gitFixture(["rev-parse", "HEAD"], dir).trim();

    gitFixture(["checkout", "-q", "--orphan", "branch-b"], dir);
    gitFixture(["commit", "-q", "--allow-empty", "-m", "b"], dir);
    const hashB = gitFixture(["rev-parse", "HEAD"], dir).trim();

    gitFixture(["checkout", "-q", "branch-a"], dir);
    gitFixture(["merge", "-q", "--allow-unrelated-histories", "-m", "merge", "branch-b"], dir);

    const expected = [hashA, hashB].sort()[0];
    expect(await fingerprint(dir)).toBe(expected);
  });
});
