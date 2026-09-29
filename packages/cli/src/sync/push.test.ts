/**
 * pushDocs 的单元测试：用可控的假 ApiClient 驱动 manifest / commit / putBytes 三个请求，
 * 覆盖 commit 失败之后的各条分支（约定见 push.ts 里的注释），不需要真实网络或测试服务端。
 * 首次同步与增量、跳过大文件与软链接、锁互斥这些端到端场景在 apps/web/src/kh-e2e/sync.test.ts。
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../http/client";
import { fakeContext } from "../repo/test-helpers";
import type { RegisteredRepo } from "../repo/root";
import { CliError, EXIT } from "../errors";
import { PUSHED_LIMIT } from "@kanban-hub/core/pull";
import { pushDocs } from "./push";
import { openSyncState } from "./state";

// 默认原样调用真实实现；个别用例用 mockImplementationOnce 注入写缓存失败
vi.mock("./state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./state")>();
  return { ...actual, openSyncState: vi.fn(actual.openSyncState) };
});

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

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

interface RepoFixture {
  home: string;
  root: string;
  registered: RegisteredRepo;
}

/** 建一个临时仓库根（docs/a.md 内容为 "hello"）和一个独立的 KH_HOME，返回 pushDocs 需要的 repo 对象 */
async function setupRepo(): Promise<RepoFixture> {
  const home = await tempDir("kh-push-home-");
  const root = await tempDir("kh-push-repo-");
  await fs.mkdir(path.join(root, "docs"), { recursive: true });
  await fs.writeFile(path.join(root, "docs", "a.md"), "hello");
  return {
    home,
    root,
    registered: {
      root,
      config: {
        projectId: "p000000001",
        sync: { include: ["docs/**"], exclude: [], maxFileSize: 5 * 1024 * 1024 },
        pull: { auto: true },
      },
    },
  };
}

function stateJsonPath(home: string, projectId: string): string {
  return path.join(home, "cache", projectId, "state.json");
}

function blobPath(home: string, projectId: string, sha: string): string {
  return path.join(home, "cache", projectId, "blobs", sha);
}

/** 断言本机同步状态没有落盘：失败的尝试不应该写入 seen / base / state.json，也不留推送内容的缓存 */
async function expectNoLocalState(home: string, projectId: string): Promise<void> {
  await expect(fs.stat(stateJsonPath(home, projectId))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.stat(path.join(home, "cache", projectId, "blobs"))).rejects.toMatchObject({ code: "ENOENT" });
}

async function readPushed(home: string, projectId: string): Promise<Record<string, string[]> | undefined> {
  const saved = JSON.parse(await fs.readFile(stateJsonPath(home, projectId), "utf8")) as { pushed?: Record<string, string[]> };
  return saved.pushed;
}

type PostHandler = (url: string, body: unknown) => unknown | Promise<unknown>;
type PutBytesHandler = (url: string, bytes: Uint8Array) => unknown | Promise<unknown>;

/** 只实现 pushDocs 用得到的 post / putBytes 两个方法；其余方法不会被调用，调用了就说明实现变了 */
class FakeClient {
  postCalls: { url: string; body: unknown }[] = [];
  putCalls: { url: string; bytes: Uint8Array }[] = [];

  constructor(
    private readonly onPost: PostHandler,
    private readonly onPutBytes: PutBytesHandler = () => ({ ok: true }),
  ) {}

  async post(url: string, body: unknown): Promise<unknown> {
    this.postCalls.push({ url, body });
    return await this.onPost(url, body);
  }

  async putBytes(url: string, bytes: Uint8Array): Promise<unknown> {
    this.putCalls.push({ url, bytes });
    return await this.onPutBytes(url, bytes);
  }
}

function asApiClient(client: FakeClient): ApiClient {
  return client as unknown as ApiClient;
}

function isManifestUrl(url: string): boolean {
  return url.endsWith("/sync/manifest");
}

function isCommitUrl(url: string): boolean {
  return url.endsWith("/sync/commit");
}

describe("pushDocs：commit 失败之后的重试分支", () => {
  it("commit 返回 400 missingBlobs：往同一个 syncId 补传后再 commit 一次就成功，manifest 只请求一次", async () => {
    const repo = await setupRepo();
    const shaA = sha256("hello");
    let commitCalls = 0;

    const client = new FakeClient((url) => {
      if (isManifestUrl(url)) return { syncId: "s1", missing: [], expiresAt: "2026-01-01T00:00:00.000Z" };
      if (isCommitUrl(url)) {
        commitCalls += 1;
        if (commitCalls === 1) {
          throw new CliError(EXIT.DATA, "缺少内容", undefined, { missingBlobs: [shaA] });
        }
        return { added: 1, modified: 0, removed: 0, unchanged: 0, lastSyncAt: "2026-01-01T00:00:00.000Z" };
      }
      throw new Error(`未预期的请求：${url}`);
    });

    const ctx = fakeContext({ env: { ...process.env, KH_HOME: repo.home } });
    const result = await pushDocs(ctx, repo.registered, asApiClient(client), { quiet: true });

    expect(result.added).toBe(1);
    expect(client.postCalls.filter((c) => isManifestUrl(c.url))).toHaveLength(1);
    expect(commitCalls).toBe(2);
    expect(client.putCalls).toHaveLength(1);
    expect(client.putCalls[0]!.url).toContain(shaA);

    // 这次是成功的，state.json 应该已经落盘（和失败分支的“没有写入”正好对照）
    await expect(fs.stat(stateJsonPath(repo.home, repo.registered.config.projectId))).resolves.toBeDefined();
  });

  it("补传后仍然缺内容：从第一步整体重来一次，第二次还失败就报错，不会无限重试", async () => {
    const repo = await setupRepo();
    const shaA = sha256("hello");
    let commitCalls = 0;

    const client = new FakeClient((url) => {
      if (isManifestUrl(url)) return { syncId: "s1", missing: [], expiresAt: "2026-01-01T00:00:00.000Z" };
      if (isCommitUrl(url)) {
        commitCalls += 1;
        throw new CliError(EXIT.DATA, "缺少内容", undefined, { missingBlobs: [shaA] });
      }
      throw new Error(`未预期的请求：${url}`);
    });

    const ctx = fakeContext({ env: { ...process.env, KH_HOME: repo.home } });
    await expect(pushDocs(ctx, repo.registered, asApiClient(client), { quiet: true })).rejects.toMatchObject({
      exitCode: EXIT.DATA,
    });

    // 每次尝试内部补传一次、commit 两次；总共只重来一次（两次完整尝试），不会没完没了
    expect(client.postCalls.filter((c) => isManifestUrl(c.url))).toHaveLength(2);
    expect(commitCalls).toBe(4);
    await expectNoLocalState(repo.home, repo.registered.config.projectId);
  });

  it("commit 返回 503：不重来，原样报出服务端的说明，退出码 4", async () => {
    const repo = await setupRepo();
    let commitCalls = 0;

    const client = new FakeClient((url) => {
      if (isManifestUrl(url)) return { syncId: "s1", missing: [], expiresAt: "2026-01-01T00:00:00.000Z" };
      if (isCommitUrl(url)) {
        commitCalls += 1;
        throw new CliError(EXIT.UNREACHABLE, "上一次同步还没有应用完成，请稍后重试", undefined, undefined, {
          status: 503,
          code: "unavailable",
        });
      }
      throw new Error(`未预期的请求：${url}`);
    });

    const ctx = fakeContext({ env: { ...process.env, KH_HOME: repo.home } });
    await expect(pushDocs(ctx, repo.registered, asApiClient(client), { quiet: true })).rejects.toMatchObject({
      exitCode: EXIT.UNREACHABLE,
      message: expect.stringContaining("上一次同步还没有应用完成"),
    });

    expect(commitCalls).toBe(1);
    expect(client.postCalls.filter((c) => isManifestUrl(c.url))).toHaveLength(1);
    await expectNoLocalState(repo.home, repo.registered.config.projectId);
  });

  it("commit 时连不上服务端：保留原来的退出码 4 和原因，不说成服务端还在处理，也不重来", async () => {
    const repo = await setupRepo();
    let commitCalls = 0;

    const client = new FakeClient((url) => {
      if (isManifestUrl(url)) return { syncId: "s1", missing: [], expiresAt: "2026-01-01T00:00:00.000Z" };
      if (isCommitUrl(url)) {
        commitCalls += 1;
        throw new CliError(EXIT.UNREACHABLE, "无法连接到服务端：http://127.0.0.1:1（ECONNREFUSED）");
      }
      throw new Error(`未预期的请求：${url}`);
    });

    const ctx = fakeContext({ env: { ...process.env, KH_HOME: repo.home } });
    const err = await pushDocs(ctx, repo.registered, asApiClient(client), { quiet: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(EXIT.UNREACHABLE);
    expect((err as CliError).message).toContain("无法连接到服务端");
    expect((err as CliError).message).not.toContain("还在处理");
    expect(commitCalls).toBe(1);
    await expectNoLocalState(repo.home, repo.registered.config.projectId);
  });

  it("commit 返回 500：退出码仍是 1，报服务端给的原因，不说成服务端还在处理", async () => {
    const repo = await setupRepo();

    const client = new FakeClient((url) => {
      if (isManifestUrl(url)) return { syncId: "s1", missing: [], expiresAt: "2026-01-01T00:00:00.000Z" };
      if (isCommitUrl(url)) {
        throw new CliError(EXIT.UNEXPECTED, "服务端内部错误", undefined, undefined, { status: 500, code: "internal" });
      }
      throw new Error(`未预期的请求：${url}`);
    });

    const ctx = fakeContext({ env: { ...process.env, KH_HOME: repo.home } });
    const err = await pushDocs(ctx, repo.registered, asApiClient(client), { quiet: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(EXIT.UNEXPECTED);
    expect((err as CliError).message).toBe("服务端内部错误");
    await expectNoLocalState(repo.home, repo.registered.config.projectId);
  });

  it("commit 返回 503 但错误码不是 unavailable（例如网关直接回的 503）：保留原来的退出码 4", async () => {
    const repo = await setupRepo();

    const client = new FakeClient((url) => {
      if (isManifestUrl(url)) return { syncId: "s1", missing: [], expiresAt: "2026-01-01T00:00:00.000Z" };
      if (isCommitUrl(url)) throw new CliError(EXIT.UNREACHABLE, "服务端暂时不可用", undefined, undefined, { status: 503 });
      throw new Error(`未预期的请求：${url}`);
    });

    const ctx = fakeContext({ env: { ...process.env, KH_HOME: repo.home } });
    const err = await pushDocs(ctx, repo.registered, asApiClient(client), { quiet: true }).catch((e: unknown) => e);
    expect((err as CliError).exitCode).toBe(EXIT.UNREACHABLE);
    expect((err as CliError).message).not.toContain("还在处理");
  });

  it("上传前重新读取文件发现内容被改动：报错退出码 1，不重试，也不会走到 commit", async () => {
    const repo = await setupRepo();
    const shaA = sha256("hello");
    const filePath = path.join(repo.root, "docs", "a.md");

    const client = new FakeClient(async (url) => {
      if (isManifestUrl(url)) {
        // 模拟“扫描、算完 hash 之后，上传之前，文件被改动了”
        await fs.writeFile(filePath, "changed");
        return { syncId: "s1", missing: [shaA], expiresAt: "2026-01-01T00:00:00.000Z" };
      }
      if (isCommitUrl(url)) throw new Error("不应该走到 commit：内容 hash 对不上时应该在上传阶段就报错");
      throw new Error(`未预期的请求：${url}`);
    });

    const ctx = fakeContext({ env: { ...process.env, KH_HOME: repo.home } });
    await expect(pushDocs(ctx, repo.registered, asApiClient(client), { quiet: true })).rejects.toMatchObject({
      exitCode: EXIT.UNEXPECTED,
      message: expect.stringContaining("被修改"),
    });

    expect(client.postCalls.filter((c) => isManifestUrl(c.url))).toHaveLength(1);
    expect(client.putCalls).toHaveLength(0);
    await expectNoLocalState(repo.home, repo.registered.config.projectId);
  });
});

describe("pushDocs：skipIfUnchangedWithinMs", () => {
  const WINDOW = 600_000;
  const T0 = Date.parse("2026-09-29T00:00:00.000Z");

  function okClient(): FakeClient {
    return new FakeClient((url) => {
      if (isManifestUrl(url)) return { syncId: "s1", missing: [], expiresAt: "2026-09-30T00:00:00.000Z" };
      if (isCommitUrl(url)) return { added: 1, modified: 0, removed: 0, unchanged: 0, lastSyncAt: "2026-09-29T00:00:00.000Z" };
      throw new Error(`未预期的请求：${url}`);
    });
  }

  function ctxAt(home: string, ms: number) {
    return fakeContext({ env: { ...process.env, KH_HOME: home }, now: () => new Date(ms) });
  }

  it("推送成功后记下 lastPush；窗口内清单没有变化：跳过，不发任何请求，不改状态文件", async () => {
    const repo = await setupRepo();
    const first = okClient();
    const r1 = await pushDocs(ctxAt(repo.home, T0), repo.registered, asApiClient(first), { quiet: true, skipIfUnchangedWithinMs: WINDOW });
    expect(r1.skippedUnchanged).toBe(false);
    expect(first.postCalls).toHaveLength(2);

    const statePath = stateJsonPath(repo.home, repo.registered.config.projectId);
    const saved = JSON.parse(await fs.readFile(statePath, "utf8")) as { lastPush?: { at: string; digest: string } };
    expect(saved.lastPush?.at).toBe("2026-09-29T00:00:00.000Z");
    expect(saved.lastPush?.digest).toMatch(/^[0-9a-f]{64}$/);
    const before = await fs.readFile(statePath);

    const second = okClient();
    const r2 = await pushDocs(ctxAt(repo.home, T0 + WINDOW - 1), repo.registered, asApiClient(second), {
      quiet: true,
      skipIfUnchangedWithinMs: WINDOW,
    });
    expect(r2.skippedUnchanged).toBe(true);
    expect(second.postCalls).toHaveLength(0);
    expect(second.putCalls).toHaveLength(0);
    expect(await fs.readFile(statePath)).toEqual(before);
  });

  it("改了文件：照常推送", async () => {
    const repo = await setupRepo();
    await pushDocs(ctxAt(repo.home, T0), repo.registered, asApiClient(okClient()), { quiet: true, skipIfUnchangedWithinMs: WINDOW });
    await fs.writeFile(path.join(repo.root, "docs", "a.md"), "hello again");
    const client = okClient();
    const r = await pushDocs(ctxAt(repo.home, T0 + 1000), repo.registered, asApiClient(client), { quiet: true, skipIfUnchangedWithinMs: WINDOW });
    expect(r.skippedUnchanged).toBe(false);
    expect(client.postCalls).toHaveLength(2);
  });

  it("超过窗口没有变化：照常推送", async () => {
    const repo = await setupRepo();
    await pushDocs(ctxAt(repo.home, T0), repo.registered, asApiClient(okClient()), { quiet: true, skipIfUnchangedWithinMs: WINDOW });
    const client = okClient();
    const r = await pushDocs(ctxAt(repo.home, T0 + WINDOW), repo.registered, asApiClient(client), { quiet: true, skipIfUnchangedWithinMs: WINDOW });
    expect(r.skippedUnchanged).toBe(false);
    expect(client.postCalls).toHaveLength(2);
  });

  it("不传这个选项（kh sync、register 的首次同步）：不受窗口影响，每次都推送", async () => {
    const repo = await setupRepo();
    await pushDocs(ctxAt(repo.home, T0), repo.registered, asApiClient(okClient()), { quiet: true });
    const client = okClient();
    const r = await pushDocs(ctxAt(repo.home, T0 + 1000), repo.registered, asApiClient(client), { quiet: true });
    expect(r.skippedUnchanged).toBe(false);
    expect(client.postCalls).toHaveLength(2);
  });
});

describe("pushDocs：留存推送过的内容", () => {
  const PID = "p000000001";

  /** 服务端要求补传 missing 里的内容，commit 成功；onCommit 在 commit 应答之前执行 */
  function client(missing: (body: unknown) => string[] = () => [], onCommit: () => Promise<void> = async () => {}): FakeClient {
    return new FakeClient(async (url, body) => {
      if (isManifestUrl(url)) return { syncId: "s1", missing: missing(body), expiresAt: "2026-09-30T00:00:00.000Z" };
      if (isCommitUrl(url)) {
        await onCommit();
        return { added: 1, modified: 0, removed: 0, unchanged: 0, lastSyncAt: "2026-09-29T00:00:00.000Z" };
      }
      throw new Error(`未预期的请求：${url}`);
    });
  }

  function ctxOf(home: string) {
    return fakeContext({ env: { ...process.env, KH_HOME: home } });
  }

  async function pushContent(repo: RepoFixture, content: string): Promise<void> {
    await fs.writeFile(path.join(repo.root, "docs", "a.md"), content);
    await pushDocs(ctxOf(repo.home), repo.registered, asApiClient(client()), { quiet: true });
  }

  async function blobExists(home: string, blobSha: string): Promise<boolean> {
    return fs.stat(blobPath(home, PID, blobSha)).then(
      () => true,
      () => false,
    );
  }

  it("上传过的内容：推送成功后记进推送历史，内容存进本机缓存", async () => {
    const repo = await setupRepo();
    const shaA = sha256("hello");
    await pushDocs(ctxOf(repo.home), repo.registered, asApiClient(client(() => [shaA])), { quiet: true });
    expect(await readPushed(repo.home, PID)).toEqual({ "docs/a.md": [shaA] });
    expect(await fs.readFile(blobPath(repo.home, PID, shaA), "utf8")).toBe("hello");
  });

  it("服务端已有、不需要上传的内容：重新读取后同样存进本机缓存", async () => {
    const repo = await setupRepo();
    const shaA = sha256("hello");
    await pushDocs(ctxOf(repo.home), repo.registered, asApiClient(client()), { quiet: true });
    expect(await readPushed(repo.home, PID)).toEqual({ "docs/a.md": [shaA] });
    expect(await fs.readFile(blobPath(repo.home, PID, shaA), "utf8")).toBe("hello");
  });

  it("没有拉取过：推送过的每个版本都按先后留下；内容没变再推送不重复记", async () => {
    const repo = await setupRepo();
    await pushContent(repo, "hello");
    await pushContent(repo, "hello v2");
    await pushContent(repo, "hello v2");
    expect(await readPushed(repo.home, PID)).toEqual({ "docs/a.md": [sha256("hello"), sha256("hello v2")] });
    expect(await blobExists(repo.home, sha256("hello"))).toBe(true);
    expect(await blobExists(repo.home, sha256("hello v2"))).toBe(true);
  });

  it("改回推送过的旧版本：移到末尾，不重复", async () => {
    const repo = await setupRepo();
    await pushContent(repo, "v1");
    await pushContent(repo, "v2");
    await pushContent(repo, "v1");
    expect(await readPushed(repo.home, PID)).toEqual({ "docs/a.md": [sha256("v2"), sha256("v1")] });
  });

  it(`推送 ${PUSHED_LIMIT + 1} 个不同版本后只剩最近 ${PUSHED_LIMIT} 份，最旧的内容被清理`, async () => {
    const repo = await setupRepo();
    for (let i = 0; i <= PUSHED_LIMIT; i++) await pushContent(repo, `version ${i}`);
    const history = (await readPushed(repo.home, PID))!["docs/a.md"]!;
    expect(history).toHaveLength(PUSHED_LIMIT);
    expect(history[0]).toBe(sha256("version 1"));
    expect(history.at(-1)).toBe(sha256(`version ${PUSHED_LIMIT}`));
    expect(await blobExists(repo.home, sha256("version 0"))).toBe(false);
    expect(await blobExists(repo.home, sha256("version 1"))).toBe(true);
  });

  it("文件删除后再推送：推送历史和对应的内容都被清理", async () => {
    const repo = await setupRepo();
    await fs.writeFile(path.join(repo.root, "docs", "b.md"), "keep");
    await pushContent(repo, "v1");
    await pushContent(repo, "v2");
    await fs.rm(path.join(repo.root, "docs", "a.md"));
    await pushDocs(ctxOf(repo.home), repo.registered, asApiClient(client()), { quiet: true });
    expect(await readPushed(repo.home, PID)).toEqual({ "docs/b.md": [sha256("keep")] });
    expect(await blobExists(repo.home, sha256("v1"))).toBe(false);
    expect(await blobExists(repo.home, sha256("v2"))).toBe(false);
  });

  it("推送成功后重新读取时文件又被改了：hash 对不上，不追加这一次，已有的历史保留", async () => {
    const repo = await setupRepo();
    await pushContent(repo, "v1");
    await fs.writeFile(path.join(repo.root, "docs", "a.md"), "v2");
    const changeDuringCommit = () => fs.writeFile(path.join(repo.root, "docs", "a.md"), "v3");
    await pushDocs(ctxOf(repo.home), repo.registered, asApiClient(client(() => [], changeDuringCommit)), { quiet: true });
    expect(await readPushed(repo.home, PID)).toEqual({ "docs/a.md": [sha256("v1")] });
    expect(await blobExists(repo.home, sha256("v1"))).toBe(true);
    expect(await blobExists(repo.home, sha256("v2"))).toBe(false);
    expect(await blobExists(repo.home, sha256("v3"))).toBe(false);
  });

  it("写本机缓存出错（例如磁盘满）：推送照样成功、只推一次，不追加这一次", async () => {
    const repo = await setupRepo();
    const actual = await vi.importActual<typeof import("./state")>("./state");
    vi.mocked(openSyncState).mockImplementationOnce(async (...args) => {
      const state = await actual.openSyncState(...args);
      state.putBlob = async () => {
        throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
      };
      return state;
    });
    const fake = client();
    const result = await pushDocs(ctxOf(repo.home), repo.registered, asApiClient(fake), { quiet: true });
    expect(result.added).toBe(1);
    expect(fake.postCalls.filter((c) => isCommitUrl(c.url))).toHaveLength(1);
    expect(fake.postCalls.filter((c) => isManifestUrl(c.url))).toHaveLength(1);
    expect(await readPushed(repo.home, PID)).toEqual({});
  });
});
