import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KhError } from "@kanban-hub/core/errors";
import { sequentialIds } from "@kanban-hub/core/test-fixtures";
import { AUTH_FILES, AuthRepo } from "./auth";
import { WriteQueue } from "./queue";

const NOW = "2026-09-23T10:00:00.000Z";
const HASH = "a".repeat(64);
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "kh-auth-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function openRepo(newId = sequentialIds("a"), now = NOW): Promise<AuthRepo> {
  const repo = new AuthRepo(dir, new WriteQueue(), { now: () => new Date(now), newId });
  await repo.load();
  return repo;
}

async function fileMode(rel: string): Promise<number> {
  return (await fs.stat(path.join(dir, rel))).mode & 0o777;
}

describe("AuthRepo", () => {
  it.skipIf(process.platform === "win32")("首次加载时生成会话密钥，权限 600，再次加载不变", async () => {
    const first = await openRepo();
    expect(first.sessionSecret().length).toBeGreaterThanOrEqual(32);
    expect(await fileMode(AUTH_FILES.sessionSecret)).toBe(0o600);
    expect(await fileMode("auth")).toBe(0o700);
    expect((await openRepo()).sessionSecret()).toBe(first.sessionSecret());
  });

  it.skipIf(process.platform === "win32")("auth 目录已存在且权限不是 700 时，加载后修正为 700", async () => {
    await fs.mkdir(path.join(dir, "auth"), { recursive: true });
    await fs.chmod(path.join(dir, "auth"), 0o755);
    await openRepo();
    expect(await fileMode("auth")).toBe(0o700);
  });

  it("密钥文件内容过短时重新生成", async () => {
    await fs.mkdir(path.join(dir, "auth"), { recursive: true });
    await fs.writeFile(path.join(dir, AUTH_FILES.sessionSecret), "short\n");
    expect((await openRepo()).sessionSecret()).not.toBe("short");
  });

  it.skipIf(process.platform === "win32")("创建的用户重新加载后仍在，文件权限 600", async () => {
    const repo = await openRepo();
    const user = await repo.createUser({ name: "Alice", role: "admin", passwordHash: "scrypt$x" });
    expect(user).toMatchObject({ id: "a000000001", version: 1, sessionVersion: 0, createdAt: NOW, updatedAt: NOW });
    expect((await openRepo()).getUser(user.id)).toEqual(user);
    expect(await fileMode(AUTH_FILES.users)).toBe(0o600);
  });

  it("更新用户：版本加 1，更新时间刷新", async () => {
    const user = await (await openRepo()).createUser({ name: "Alice", role: "admin", passwordHash: "scrypt$x" });
    const later = await openRepo(sequentialIds("b"), "2026-09-24T00:00:00.000Z");
    expect(await later.updateUser(user.id, { sessionVersion: 1 })).toMatchObject({
      version: 2,
      sessionVersion: 1,
      createdAt: NOW,
      updatedAt: "2026-09-24T00:00:00.000Z",
    });
  });

  it("更新不存在的用户时报 not_found", async () => {
    const repo = await openRepo();
    await expect(repo.updateUser("zzzzzzzzzz", { name: "x" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("校验失败时报 invalid，不写文件", async () => {
    const repo = await openRepo();
    const err = await repo
      .createMachine({ name: "mac", userId: "a000000001", os: "darwin", tokenHash: "bad" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KhError);
    expect((err as KhError).code).toBe("invalid");
    await expect(fs.stat(path.join(dir, AUTH_FILES.machines))).rejects.toThrow();
  });

  it("同时创建两台机器，两台都保存下来", async () => {
    const repo = await openRepo();
    await Promise.all([
      repo.createMachine({ name: "mac", userId: "a000000009", os: "darwin", tokenHash: HASH }),
      repo.createMachine({ name: "linux", userId: "a000000009", os: "linux", tokenHash: HASH }),
    ]);
    expect((await openRepo()).listMachines().map((m) => m.name)).toEqual(["mac", "linux"]);
  });

  it("吊销机器时记录吊销时间，版本加 1", async () => {
    const repo = await openRepo();
    const machine = await repo.createMachine({ name: "mac", userId: "a000000009", os: "darwin", tokenHash: HASH });
    expect(await repo.updateMachine(machine.id, { revokedAt: NOW })).toMatchObject({ revokedAt: NOW, version: 2 });
  });
});
