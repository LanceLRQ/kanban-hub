import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Machine } from "@kanban-hub/core/schema";
import { sequentialIds } from "@kanban-hub/core/test-fixtures";
import { AuthRepo } from "../store/auth";
import { WriteQueue } from "../store/queue";
import { authenticate, LastSeenTracker } from "./authenticate";
import { verifyPassword } from "./password";
import { SESSION_COOKIE, signSession } from "./session";
import { generateMachineToken, hashToken } from "./token";
import { syncAdminPassword } from "./admin";

const NOW = "2026-09-24T10:00:00.000Z";
// 低成本参数：避免每个用例都跑一遍默认成本的 scrypt
const LOW_COST = { N: 16, r: 1, p: 1 };
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "kh-admin-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function openRepo(): Promise<AuthRepo> {
  const repo = new AuthRepo(dir, new WriteQueue(), { now: () => new Date(NOW), newId: sequentialIds("u") });
  await repo.load();
  return repo;
}

/** 记下每次 touch 返回的 Promise，测试里等它结束，避免临时目录先被清理导致假失败 */
class TrackedTracker extends LastSeenTracker {
  last: Promise<void> = Promise.resolve();
  override touch(machine: Machine, auth: AuthRepo): Promise<void> {
    this.last = super.touch(machine, auth);
    return this.last;
  }
}

function findAdmin(auth: AuthRepo) {
  const admin = auth.listUsers().find((u) => u.role === "admin");
  if (!admin) throw new Error("测试前置条件不满足：管理员不存在");
  return admin;
}

describe("syncAdminPassword", () => {
  it("没有管理员时新建一个，名字为 admin", async () => {
    const auth = await openRepo();
    const result = await syncAdminPassword(auth, "hunter2", LOW_COST);
    expect(result).toBe("created");

    const admin = findAdmin(auth);
    expect(admin.name).toBe("admin");
    expect(admin.role).toBe("admin");
    expect(await verifyPassword("hunter2", admin.passwordHash)).toBe(true);
  });

  it("已有管理员且密码一致时什么都不做", async () => {
    const auth = await openRepo();
    await syncAdminPassword(auth, "hunter2", LOW_COST);
    const before = findAdmin(auth);

    const result = await syncAdminPassword(auth, "hunter2", LOW_COST);
    expect(result).toBe("unchanged");
    expect(findAdmin(auth)).toEqual(before);
  });

  it("密码不一致时用一次 updateUser 同时更新哈希和 sessionVersion", async () => {
    const auth = await openRepo();
    await syncAdminPassword(auth, "hunter2", LOW_COST);
    const before = findAdmin(auth);

    const result = await syncAdminPassword(auth, "new-password", LOW_COST);
    expect(result).toBe("updated");

    const after = findAdmin(auth);
    expect(after.sessionVersion).toBe(before.sessionVersion + 1);
    expect(after.passwordHash).not.toBe(before.passwordHash);
    expect(await verifyPassword("new-password", after.passwordHash)).toBe(true);
    expect(await verifyPassword("hunter2", after.passwordHash)).toBe(false);
  });

  it("同步之后，用环境变量里的密码能校验通过", async () => {
    const auth = await openRepo();
    await syncAdminPassword(auth, "hunter2", LOW_COST);
    expect(await verifyPassword("hunter2", findAdmin(auth).passwordHash)).toBe(true);
  });

  it("不传成本参数时使用 hashPassword 的默认成本", async () => {
    const auth = await openRepo();
    await syncAdminPassword(auth, "hunter2");
    const admin = findAdmin(auth);
    expect(admin.passwordHash.split("$").slice(1, 4)).toEqual(["16384", "8", "1"]);
  });

  it("更新密码后旧网页会话失效，但已配对机器的令牌仍然有效", async () => {
    const auth = await openRepo();
    await syncAdminPassword(auth, "hunter2", LOW_COST);
    const admin = findAdmin(auth);

    const token = generateMachineToken();
    await auth.createMachine({ name: "mac", userId: admin.id, os: "darwin", tokenHash: hashToken(token) });
    const oldSession = signSession(
      { userId: admin.id, sessionVersion: admin.sessionVersion, expiresAt: Date.parse(NOW) + 1000 },
      auth.sessionSecret(),
    );

    await syncAdminPassword(auth, "new-password", LOW_COST);

    const seen = new TrackedTracker({ now: () => new Date(NOW), log: () => {} });
    const deps = { auth, now: () => new Date(NOW), seen };
    const sessionReq = new Request("http://localhost/api/v1/me", { headers: { cookie: `${SESSION_COOKIE}=${oldSession}` } });
    expect(await authenticate(sessionReq, deps)).toBeNull();

    const tokenReq = new Request("http://localhost/api/v1/me", { headers: { authorization: `Bearer ${token}` } });
    const principal = await authenticate(tokenReq, deps);
    expect(principal?.kind).toBe("machine");
    // 令牌鉴权成功会触发 lastSeenAt 的后台写入：等它结束再让 afterEach 清理临时目录，避免竞态
    await seen.last;
  });
});
