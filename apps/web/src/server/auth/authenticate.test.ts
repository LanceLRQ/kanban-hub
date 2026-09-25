import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Machine, User } from "@kanban-hub/core/schema";
import { sequentialIds } from "@kanban-hub/core/test-fixtures";
import { AuthRepo } from "../store/auth";
import { WriteQueue } from "../store/queue";
import { SESSION_COOKIE, signSession } from "./session";
import { generateMachineToken, hashToken } from "./token";
import { authenticate, LastSeenTracker, toActor, verifySessionCookie, type AuthenticateDeps } from "./authenticate";

const NOW = "2026-09-24T10:00:00.000Z";
const HASH = "a".repeat(64);
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "kh-authenticate-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function openRepo(): Promise<AuthRepo> {
  const repo = new AuthRepo(dir, new WriteQueue(), { now: () => new Date(NOW), newId: sequentialIds("u") });
  await repo.load();
  return repo;
}

function request(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/v1/me", { headers });
}

function fakeUser(id: string): User {
  return { id, version: 1, createdAt: NOW, updatedAt: NOW, name: "x", role: "member", passwordHash: "x", sessionVersion: 0 };
}

function fakeMachine(id: string): Machine {
  return {
    id,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    name: "mac",
    userId: "u1",
    os: "darwin",
    tokenHash: HASH,
    lastSeenAt: null,
    revokedAt: null,
  };
}

/** 记下每次 touch 返回的 Promise，测试里等它结束，避免临时目录先被清理导致假失败 */
class TrackedTracker extends LastSeenTracker {
  last: Promise<void> = Promise.resolve();
  override touch(machine: Machine, auth: AuthRepo): Promise<void> {
    this.last = super.touch(machine, auth);
    return this.last;
  }
}

function makeDeps(auth: AuthRepo, seen: LastSeenTracker = new TrackedTracker({ now: () => new Date(NOW), log: () => {} })): AuthenticateDeps {
  return { auth, now: () => new Date(NOW), seen };
}

describe("authenticate：令牌鉴权", () => {
  it("正确的令牌返回机器操作者", async () => {
    const auth = await openRepo();
    const user = await auth.createUser({ name: "Alice", role: "member", passwordHash: "x" });
    const token = generateMachineToken();
    const machine = await auth.createMachine({ name: "mac", userId: user.id, os: "darwin", tokenHash: hashToken(token) });
    const seen = new TrackedTracker({ now: () => new Date(NOW), log: () => {} });

    const principal = await authenticate(request({ authorization: `Bearer ${token}` }), makeDeps(auth, seen));
    expect(principal).toEqual({ kind: "machine", user, machine });
    await seen.last;
  });

  it("令牌格式不对时返回 null", async () => {
    const auth = await openRepo();
    const principal = await authenticate(request({ authorization: "Bearer not-a-real-token" }), makeDeps(auth));
    expect(principal).toBeNull();
  });

  it("Authorization 不是 Bearer 格式，也没有 cookie 时返回 null", async () => {
    const auth = await openRepo();
    const principal = await authenticate(request({ authorization: "Basic xxxx" }), makeDeps(auth));
    expect(principal).toBeNull();
  });

  it("Authorization 是其他 scheme（如反向代理加的 Basic）时忽略它，按会话 cookie 鉴权", async () => {
    const auth = await openRepo();
    const user = await auth.createUser({ name: "Alice", role: "admin", passwordHash: "x" });
    const value = signSession(
      { userId: user.id, sessionVersion: user.sessionVersion, expiresAt: Date.parse(NOW) + 1000 },
      auth.sessionSecret(),
    );

    const principal = await authenticate(
      request({ authorization: "Basic xxxx", cookie: `${SESSION_COOKIE}=${value}` }),
      makeDeps(auth),
    );
    expect(principal).toEqual({ kind: "session", user });
  });

  it("Authorization 是 Bearer 但令牌格式不对时返回 null，不回退到 cookie", async () => {
    const auth = await openRepo();
    const user = await auth.createUser({ name: "Alice", role: "admin", passwordHash: "x" });
    const value = signSession(
      { userId: user.id, sessionVersion: user.sessionVersion, expiresAt: Date.parse(NOW) + 1000 },
      auth.sessionSecret(),
    );

    const principal = await authenticate(
      request({ authorization: "Bearer not-a-real-token", cookie: `${SESSION_COOKIE}=${value}` }),
      makeDeps(auth),
    );
    expect(principal).toBeNull();
  });

  it("令牌不存在时返回 null", async () => {
    const auth = await openRepo();
    const token = generateMachineToken();
    const principal = await authenticate(request({ authorization: `Bearer ${token}` }), makeDeps(auth));
    expect(principal).toBeNull();
  });

  it("机器已吊销时返回 null", async () => {
    const auth = await openRepo();
    const user = await auth.createUser({ name: "Alice", role: "member", passwordHash: "x" });
    const token = generateMachineToken();
    const machine = await auth.createMachine({ name: "mac", userId: user.id, os: "darwin", tokenHash: hashToken(token) });
    await auth.updateMachine(machine.id, { revokedAt: NOW });

    const principal = await authenticate(request({ authorization: `Bearer ${token}` }), makeDeps(auth));
    expect(principal).toBeNull();
  });

  it("机器所属用户不存在时返回 null", async () => {
    const auth = await openRepo();
    const token = generateMachineToken();
    // AuthRepo 不校验 userId 是否存在：用一个从未创建过的用户 ID 模拟“用户被删”
    await auth.createMachine({ name: "mac", userId: "zzzzzzzzzz", os: "darwin", tokenHash: hashToken(token) });

    const principal = await authenticate(request({ authorization: `Bearer ${token}` }), makeDeps(auth));
    expect(principal).toBeNull();
  });

  it("同时带令牌和 cookie 时，按令牌处理", async () => {
    const auth = await openRepo();
    const user = await auth.createUser({ name: "Alice", role: "member", passwordHash: "x" });
    const token = generateMachineToken();
    const machine = await auth.createMachine({ name: "mac", userId: user.id, os: "darwin", tokenHash: hashToken(token) });
    const seen = new TrackedTracker({ now: () => new Date(NOW), log: () => {} });

    const principal = await authenticate(
      request({ authorization: `Bearer ${token}`, cookie: `${SESSION_COOKIE}=garbage` }),
      makeDeps(auth, seen),
    );
    expect(principal).toEqual({ kind: "machine", user, machine });
    await seen.last;
  });
});

describe("authenticate：会话鉴权", () => {
  it("正确的会话返回网页操作者", async () => {
    const auth = await openRepo();
    const user = await auth.createUser({ name: "Alice", role: "admin", passwordHash: "x" });
    const value = signSession(
      { userId: user.id, sessionVersion: user.sessionVersion, expiresAt: Date.parse(NOW) + 1000 },
      auth.sessionSecret(),
    );

    const principal = await authenticate(request({ cookie: `${SESSION_COOKIE}=${value}` }), makeDeps(auth));
    expect(principal).toEqual({ kind: "session", user });
  });

  it("会话过期时返回 null", async () => {
    const auth = await openRepo();
    const user = await auth.createUser({ name: "Alice", role: "admin", passwordHash: "x" });
    const value = signSession(
      { userId: user.id, sessionVersion: user.sessionVersion, expiresAt: Date.parse(NOW) - 1 },
      auth.sessionSecret(),
    );

    const principal = await authenticate(request({ cookie: `${SESSION_COOKIE}=${value}` }), makeDeps(auth));
    expect(principal).toBeNull();
  });

  it("换过 secret 后签名对不上，返回 null", async () => {
    const auth = await openRepo();
    const user = await auth.createUser({ name: "Alice", role: "admin", passwordHash: "x" });
    const value = signSession(
      { userId: user.id, sessionVersion: user.sessionVersion, expiresAt: Date.parse(NOW) + 1000 },
      "another-secret",
    );

    const principal = await authenticate(request({ cookie: `${SESSION_COOKIE}=${value}` }), makeDeps(auth));
    expect(principal).toBeNull();
  });

  it("sessionVersion 与用户当前值不一致时返回 null（改密码之后）", async () => {
    const auth = await openRepo();
    const user = await auth.createUser({ name: "Alice", role: "admin", passwordHash: "x" });
    const value = signSession(
      { userId: user.id, sessionVersion: user.sessionVersion, expiresAt: Date.parse(NOW) + 1000 },
      auth.sessionSecret(),
    );
    await auth.updateUser(user.id, { sessionVersion: user.sessionVersion + 1 });

    const principal = await authenticate(request({ cookie: `${SESSION_COOKIE}=${value}` }), makeDeps(auth));
    expect(principal).toBeNull();
  });

  it("用户不存在时返回 null", async () => {
    const auth = await openRepo();
    const value = signSession({ userId: "zzzzzzzzzz", sessionVersion: 0, expiresAt: Date.parse(NOW) + 1000 }, auth.sessionSecret());

    const principal = await authenticate(request({ cookie: `${SESSION_COOKIE}=${value}` }), makeDeps(auth));
    expect(principal).toBeNull();
  });

  it("没有 Authorization 也没有 cookie 时返回 null", async () => {
    const auth = await openRepo();
    expect(await authenticate(request({}), makeDeps(auth))).toBeNull();
  });
});

describe("verifySessionCookie：网页会话专用的校验函数，直接注入 cookie 值", () => {
  it("正确的会话值返回对应用户", async () => {
    const auth = await openRepo();
    const user = await auth.createUser({ name: "Alice", role: "admin", passwordHash: "x" });
    const value = signSession(
      { userId: user.id, sessionVersion: user.sessionVersion, expiresAt: Date.parse(NOW) + 1000 },
      auth.sessionSecret(),
    );

    expect(verifySessionCookie(value, { auth, now: () => new Date(NOW) })).toEqual({ user });
  });

  it("cookie 值为 null（未登录）时返回 null", async () => {
    const auth = await openRepo();
    expect(verifySessionCookie(null, { auth, now: () => new Date(NOW) })).toBeNull();
  });

  it("签名不对时返回 null", async () => {
    const auth = await openRepo();
    const user = await auth.createUser({ name: "Alice", role: "admin", passwordHash: "x" });
    const value = signSession(
      { userId: user.id, sessionVersion: user.sessionVersion, expiresAt: Date.parse(NOW) + 1000 },
      "another-secret",
    );

    expect(verifySessionCookie(value, { auth, now: () => new Date(NOW) })).toBeNull();
  });

  it("sessionVersion 过期（改密码之后）时返回 null", async () => {
    const auth = await openRepo();
    const user = await auth.createUser({ name: "Alice", role: "admin", passwordHash: "x" });
    const value = signSession(
      { userId: user.id, sessionVersion: user.sessionVersion, expiresAt: Date.parse(NOW) + 1000 },
      auth.sessionSecret(),
    );
    await auth.updateUser(user.id, { sessionVersion: user.sessionVersion + 1 });

    expect(verifySessionCookie(value, { auth, now: () => new Date(NOW) })).toBeNull();
  });

  it("机器令牌不是会话值，格式不对返回 null（机器令牌不能用于页面会话）", async () => {
    const auth = await openRepo();
    const token = generateMachineToken();
    expect(verifySessionCookie(token, { auth, now: () => new Date(NOW) })).toBeNull();
  });
});

describe("toActor", () => {
  it("会话操作者：machineId 为 null，via 为 web，agent 恒为 null", () => {
    const actor = toActor({ kind: "session", user: fakeUser("u1") }, "claude-code");
    expect(actor).toEqual({ userId: "u1", machineId: null, via: "web", agent: null });
  });

  it("机器操作者：带上 machineId，via 为 cli，agent 原样传递", () => {
    const actor = toActor({ kind: "machine", user: fakeUser("u1"), machine: fakeMachine("m1") }, "claude-code");
    expect(actor).toEqual({ userId: "u1", machineId: "m1", via: "cli", agent: "claude-code" });
  });

  it("机器操作者：agent 为 null 时原样传 null", () => {
    const actor = toActor({ kind: "machine", user: fakeUser("u1"), machine: fakeMachine("m1") }, null);
    expect(actor).toEqual({ userId: "u1", machineId: "m1", via: "cli", agent: null });
  });
});

describe("LastSeenTracker", () => {
  function fakeAuthWithMachine(machine: Machine) {
    const calls: Array<string | null> = [];
    let current = machine;
    const auth = {
      updateMachine: (_id: string, patch: { lastSeenAt?: string | null }) => {
        calls.push(patch.lastSeenAt ?? null);
        current = { ...current, ...patch, version: current.version + 1 };
        return Promise.resolve(current);
      },
    } as unknown as AuthRepo;
    return { auth, calls, current: () => current };
  }

  it("第一次请求就写入", async () => {
    const m = fakeMachine("m1");
    const { auth, calls, current } = fakeAuthWithMachine(m);
    const tracker = new LastSeenTracker({ now: () => new Date(NOW), log: () => {} });

    await tracker.touch(m, auth);
    expect(calls).toEqual([NOW]);
    expect(current().lastSeenAt).toBe(NOW);
  });

  it("一分钟内的多次请求只写一次，包括并发的请求", async () => {
    const m = fakeMachine("m1");
    const { auth, calls } = fakeAuthWithMachine(m);
    const tracker = new LastSeenTracker({ now: () => new Date(NOW), log: () => {} });

    // 两次同步发起的调用模拟并发请求
    await Promise.all([tracker.touch(m, auth), tracker.touch(m, auth)]);
    // 窗口内再来一次
    await tracker.touch(m, auth);
    expect(calls).toHaveLength(1);
  });

  it("超过一分钟再写一次", async () => {
    let currentMs = Date.parse(NOW);
    const m = fakeMachine("m1");
    const { auth, calls } = fakeAuthWithMachine(m);
    const tracker = new LastSeenTracker({ now: () => new Date(currentMs), intervalMs: 60_000, log: () => {} });

    await tracker.touch(m, auth);
    currentMs += 60_001;
    await tracker.touch(m, auth);
    expect(calls).toHaveLength(2);
  });

  it("写入失败只记日志，请求照常返回", async () => {
    const m = fakeMachine("m1");
    const logs: string[] = [];
    const auth = { updateMachine: () => Promise.reject(new Error("磁盘满了")) } as unknown as AuthRepo;
    const tracker = new LastSeenTracker({ now: () => new Date(NOW), log: (msg) => logs.push(msg) });

    await expect(tracker.touch(m, auth)).resolves.toBeUndefined();
    expect(logs.some((l) => l.includes("磁盘满了"))).toBe(true);
  });

  it("写入失败之后，下一次调用会重试", async () => {
    const m = fakeMachine("m1");
    let attempt = 0;
    const calls: Array<string | null> = [];
    const auth = {
      updateMachine: (_id: string, patch: { lastSeenAt?: string | null }) => {
        attempt += 1;
        if (attempt === 1) return Promise.reject(new Error("暂时失败"));
        calls.push(patch.lastSeenAt ?? null);
        return Promise.resolve({ ...m, ...patch });
      },
    } as unknown as AuthRepo;
    const tracker = new LastSeenTracker({ now: () => new Date(NOW), log: () => {} });

    await tracker.touch(m, auth);
    await tracker.touch(m, auth);
    expect(calls).toHaveLength(1);
  });
});
