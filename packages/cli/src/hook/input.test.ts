import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { writeRepoConfig } from "../repo/config";
import { cleanupDir, fakeContext, gitFixture, makeTempDir } from "../repo/test-helpers";
import { readHookInput, resolveHookRepo } from "./input";

const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) await cleanupDir(dir);
  }
});

async function tempDir(prefix?: string): Promise<string> {
  const dir = await makeTempDir(prefix);
  dirs.push(dir);
  return dir;
}

function ctxWithStdin(stdin: NodeJS.ReadableStream): ReturnType<typeof fakeContext> {
  return fakeContext({ stdin });
}

describe("readHookInput", () => {
  it("正常 JSON：解析出全部字段", async () => {
    const stdin = Readable.from([JSON.stringify({ session_id: "abc-123", cwd: "/repo", source: "startup", stop_hook_active: true })]);
    const result = await readHookInput(ctxWithStdin(stdin));
    expect(result).toEqual({ sessionId: "abc-123", cwd: "/repo", source: "startup", stopHookActive: true });
  });

  it("字段省略时用默认值：source 为 null，stopHookActive 为 false", async () => {
    const stdin = Readable.from([JSON.stringify({ session_id: "abc-123", cwd: "/repo" })]);
    const result = await readHookInput(ctxWithStdin(stdin));
    expect(result).toEqual({ sessionId: "abc-123", cwd: "/repo", source: null, stopHookActive: false });
  });

  it("session_id 含 ../：无效输入，返回 null", async () => {
    const stdin = Readable.from([JSON.stringify({ session_id: "../etc/passwd", cwd: "/repo" })]);
    expect(await readHookInput(ctxWithStdin(stdin))).toBeNull();
  });

  it("session_id 超长：无效输入，返回 null", async () => {
    const stdin = Readable.from([JSON.stringify({ session_id: "a".repeat(200), cwd: "/repo" })]);
    expect(await readHookInput(ctxWithStdin(stdin))).toBeNull();
  });

  it("空输入：无效输入，返回 null", async () => {
    const stdin = Readable.from([]);
    expect(await readHookInput(ctxWithStdin(stdin))).toBeNull();
  });

  it("不是 JSON：无效输入，返回 null", async () => {
    const stdin = Readable.from(["不是 json"]);
    expect(await readHookInput(ctxWithStdin(stdin))).toBeNull();
  });

  it("超过大小上限（注入小上限）：无效输入，返回 null", async () => {
    const stdin = Readable.from([JSON.stringify({ session_id: "abc-123", cwd: "/repo" })]);
    const result = await readHookInput(ctxWithStdin(stdin), { maxBytes: 4 });
    expect(result).toBeNull();
  });

  it("等待超时（注入 50 毫秒，流一直不结束）：返回 null，流已被销毁", async () => {
    const stdin = new Readable({ read() {} }); // 不 push 任何数据，也不 end
    const result = await readHookInput(ctxWithStdin(stdin), { timeoutMs: 50 });
    expect(result).toBeNull();
    expect(stdin.destroyed).toBe(true);
  });
});

describe("resolveHookRepo", () => {
  it("cwd 是相对路径时的输入不会崩溃：readHookInput 本身不校验 cwd 格式，交给 resolveHookRepo 处理", async () => {
    const ctx = fakeContext();
    const result = await resolveHookRepo(ctx, { sessionId: "s1", cwd: "relative/path", source: null, stopHookActive: false });
    expect(result).toBeNull();
  });

  it("cwd 不存在：返回 null", async () => {
    const dir = await tempDir();
    const ctx = fakeContext();
    const result = await resolveHookRepo(ctx, { sessionId: "s1", cwd: path.join(dir, "no-such-dir"), source: null, stopHookActive: false });
    expect(result).toBeNull();
  });

  it("cwd 是文件而不是目录：返回 null", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "a-file");
    await fs.writeFile(file, "x");
    const ctx = fakeContext();
    const result = await resolveHookRepo(ctx, { sessionId: "s1", cwd: file, source: null, stopHookActive: false });
    expect(result).toBeNull();
  });

  it("没有 .kanban-hub/ 时返回 null", async () => {
    const dir = await tempDir();
    gitFixture(["init", "-q"], dir);
    gitFixture(["commit", "-q", "--allow-empty", "-m", "init"], dir);
    const ctx = fakeContext();
    const result = await resolveHookRepo(ctx, { sessionId: "s1", cwd: dir, source: null, stopHookActive: false });
    expect(result).toBeNull();
  });

  it("仓库子目录里也能找到；cwd 经过软链接时，仓库根是真实路径", async () => {
    const dir = await tempDir();
    gitFixture(["init", "-q"], dir);
    gitFixture(["commit", "-q", "--allow-empty", "-m", "init"], dir);
    await writeRepoConfig(dir, { projectId: "p000000001", sync: { include: [], exclude: [], maxFileSize: 1024 }, pull: { auto: true } });
    const sub = path.join(dir, "a", "b");
    await fs.mkdir(sub, { recursive: true });

    const linkParent = await tempDir();
    const link = path.join(linkParent, "link-to-sub");
    await fs.symlink(sub, link, "dir");

    const ctx = fakeContext();
    const result = await resolveHookRepo(ctx, { sessionId: "s1", cwd: link, source: null, stopHookActive: false });
    expect(result).not.toBeNull();
    expect(result?.repo.root).toBe(dir);
    expect(result?.worktree).toBe(dir);
  });

  it("在链接工作树里时，repo.root 是主工作树，worktree 是链接工作树的顶层", async () => {
    const mainDir = await tempDir();
    gitFixture(["init", "-q"], mainDir);
    gitFixture(["commit", "-q", "--allow-empty", "-m", "init"], mainDir);
    await writeRepoConfig(mainDir, { projectId: "p000000001", sync: { include: [], exclude: [], maxFileSize: 1024 }, pull: { auto: true } });

    const worktreeParent = await tempDir();
    const linkedDir = path.join(worktreeParent, "linked");
    gitFixture(["worktree", "add", "-b", "feature", linkedDir], mainDir);
    dirs.push(linkedDir);

    const ctx = fakeContext();
    const result = await resolveHookRepo(ctx, { sessionId: "s1", cwd: linkedDir, source: null, stopHookActive: false });
    expect(result).not.toBeNull();
    expect(result?.repo.root).toBe(mainDir);
    expect(result?.worktree).toBe(linkedDir);
  });
});
