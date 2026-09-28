import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CliContext } from "../context";
import { cleanupDir, fakeContext, gitFixture, makeTempDir } from "../repo/test-helpers";
import { collectGitState } from "./git-state";

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

function ctxFor(root: string): CliContext {
  return fakeContext({ cwd: root });
}

describe("collectGitState", () => {
  it("不是 git 仓库时返回 null", async () => {
    const dir = await tempDir();
    expect(await collectGitState(ctxFor(dir), dir)).toBeNull();
  });

  it("没有提交时：head/headSubject/headAt 为 null，其余照常", async () => {
    const dir = await tempDir();
    gitFixture(["init", "-q"], dir);

    const state = await collectGitState(ctxFor(dir), dir);
    expect(state).not.toBeNull();
    expect(state?.head).toBeNull();
    expect(state?.headSubject).toBeNull();
    expect(state?.headAt).toBeNull();
    expect(state?.ahead).toBeNull();
    expect(state?.behind).toBeNull();
  });

  it("没有上游分支时 ahead/behind 为 null", async () => {
    const dir = await tempDir();
    gitFixture(["init", "-q"], dir);
    gitFixture(["commit", "--allow-empty", "-q", "-m", "init"], dir);

    const state = await collectGitState(ctxFor(dir), dir);
    expect(state?.ahead).toBeNull();
    expect(state?.behind).toBeNull();
    expect(state?.head).not.toBeNull();
    expect(state?.headSubject).toBe("init");
  });

  it("有上游分支时返回正确的 ahead/behind", async () => {
    const dir = await tempDir();
    gitFixture(["init", "-q"], dir);
    gitFixture(["commit", "--allow-empty", "-q", "-m", "base"], dir);
    const currentBranch = gitFixture(["rev-parse", "--abbrev-ref", "HEAD"], dir).trim();

    gitFixture(["branch", "upstream-branch"], dir);
    gitFixture(["branch", `--set-upstream-to=upstream-branch`, currentBranch], dir);

    gitFixture(["checkout", "-q", "upstream-branch"], dir);
    gitFixture(["commit", "--allow-empty", "-q", "-m", "u1"], dir);
    gitFixture(["commit", "--allow-empty", "-q", "-m", "u2"], dir);
    gitFixture(["checkout", "-q", currentBranch], dir);
    gitFixture(["commit", "--allow-empty", "-q", "-m", "c1"], dir);

    const state = await collectGitState(ctxFor(dir), dir);
    expect(state?.branch).toBe(currentBranch);
    expect(state?.ahead).toBe(1);
    expect(state?.behind).toBe(2);
    expect(state?.headSubject).toBe("c1");
  });

  it("分离 HEAD 时 branch 为 null，其余仍能取到", async () => {
    const dir = await tempDir();
    gitFixture(["init", "-q"], dir);
    gitFixture(["commit", "--allow-empty", "-q", "-m", "init"], dir);
    const hash = gitFixture(["rev-parse", "HEAD"], dir).trim();
    gitFixture(["checkout", "-q", hash], dir);

    const state = await collectGitState(ctxFor(dir), dir);
    expect(state?.branch).toBeNull();
    expect(state?.head).toBe(hash);
  });

  it("未提交改动数包含未跟踪的文件", async () => {
    const dir = await tempDir();
    gitFixture(["init", "-q"], dir);
    gitFixture(["commit", "--allow-empty", "-q", "-m", "init"], dir);

    await fs.writeFile(path.join(dir, "untracked.txt"), "x");
    let state = await collectGitState(ctxFor(dir), dir);
    expect(state?.dirtyCount).toBe(1);

    await fs.writeFile(path.join(dir, "another.txt"), "y");
    state = await collectGitState(ctxFor(dir), dir);
    expect(state?.dirtyCount).toBe(2);
  });
});
