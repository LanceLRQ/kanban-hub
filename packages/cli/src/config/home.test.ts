import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CliContext } from "../context";
import { EXIT } from "../errors";
import {
  clearMachineIdentity,
  readMachineConfig,
  readToken,
  resolveKhHome,
  writeMachineConfig,
  writeToken,
} from "./home";

function fakeContext(overrides: Partial<CliContext> = {}): CliContext {
  return {
    cwd: "/tmp",
    env: {},
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    stdin: process.stdin,
    isTTY: false,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    platform: "linux",
    hostname: "test-host",
    homeDir: "/home/test-user",
    fetch: (() => {
      throw new Error("不应该在 home 测试里调用 fetch");
    }) as unknown as typeof fetch,
    ...overrides,
  };
}

const isWindows = process.platform === "win32";

describe("resolveKhHome", () => {
  it("KH_HOME 是绝对路径时生效", () => {
    const ctx = fakeContext({ env: { KH_HOME: "/custom/kh-home" } });
    expect(resolveKhHome(ctx)).toBe("/custom/kh-home");
  });

  it("KH_HOME 是相对路径时抛用法错误", () => {
    const ctx = fakeContext({ env: { KH_HOME: "relative/kh-home" } });
    expect(() => resolveKhHome(ctx)).toThrowError(expect.objectContaining({ exitCode: EXIT.USAGE }));
  });

  it("没有 KH_HOME 时默认是 homeDir 下的 .kanban-hub", () => {
    const ctx = fakeContext({ env: {}, homeDir: "/home/alice" });
    expect(resolveKhHome(ctx)).toBe(path.join("/home/alice", ".kanban-hub"));
  });

  it("homeDir 为空时抛意外错误（找不到主目录）", () => {
    const ctx = fakeContext({ env: {}, homeDir: "" });
    expect(() => resolveKhHome(ctx)).toThrowError(expect.objectContaining({ exitCode: EXIT.UNEXPECTED }));
  });

  it("homeDir 不是绝对路径时也抛意外错误", () => {
    const ctx = fakeContext({ env: {}, homeDir: "alice" });
    expect(() => resolveKhHome(ctx)).toThrowError(expect.objectContaining({ exitCode: EXIT.UNEXPECTED }));
  });
});

describe("machine config", () => {
  let home: string;

  beforeEach(async () => {
    home = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "kh-home-")), ".kanban-hub");
  });

  afterEach(async () => {
    await fs.rm(path.dirname(home), { recursive: true, force: true });
  });

  it("读写往返一致", async () => {
    const cfg = { server: "https://kh.example.com", machineId: "m000000001", machineName: "my-mac" };
    await writeMachineConfig(home, cfg);
    expect(await readMachineConfig(home)).toEqual(cfg);
  });

  it("只有 server 的配置能读回", async () => {
    await writeMachineConfig(home, { server: "https://kh.example.com" });
    expect(await readMachineConfig(home)).toEqual({ server: "https://kh.example.com" });
  });

  it("没有写过时返回 null", async () => {
    expect(await readMachineConfig(home)).toBeNull();
  });

  it("目录权限是 700", async () => {
    await writeMachineConfig(home, { server: "https://kh.example.com", machineId: "m000000001", machineName: "my-mac" });
    if (isWindows) return;
    const stat = await fs.stat(home);
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it("损坏的 config.yaml 抛用法错误，并指出文件路径", async () => {
    await fs.mkdir(home, { recursive: true });
    const configPath = path.join(home, "config.yaml");
    await fs.writeFile(configPath, "server: [不闭合的数组\n", "utf8");

    await expect(readMachineConfig(home)).rejects.toThrowError(
      expect.objectContaining({
        exitCode: EXIT.USAGE,
        message: expect.stringContaining(configPath),
      }),
    );
  });

  it("不符合 schema 的 config.yaml 抛用法错误", async () => {
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(home, "config.yaml"), "server: 123\n", "utf8");

    await expect(readMachineConfig(home)).rejects.toThrowError(expect.objectContaining({ exitCode: EXIT.USAGE }));
  });

  it("只给 machineId 不给 machineName 抛用法错误", async () => {
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(
      path.join(home, "config.yaml"),
      "server: https://kh.example.com\nmachineId: m000000001\n",
      "utf8",
    );

    await expect(readMachineConfig(home)).rejects.toThrowError(expect.objectContaining({ exitCode: EXIT.USAGE }));
  });

  it("只给 machineName 不给 machineId 也抛用法错误", async () => {
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(
      path.join(home, "config.yaml"),
      "server: https://kh.example.com\nmachineName: my-mac\n",
      "utf8",
    );

    await expect(readMachineConfig(home)).rejects.toThrowError(expect.objectContaining({ exitCode: EXIT.USAGE }));
  });
});

describe("credentials", () => {
  let home: string;

  beforeEach(async () => {
    home = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "kh-home-")), ".kanban-hub");
  });

  afterEach(async () => {
    await fs.rm(path.dirname(home), { recursive: true, force: true });
  });

  it("读写往返一致，权限 600", async () => {
    await writeToken(home, "secret-token");
    const ctx = fakeContext();
    expect(await readToken(home, ctx)).toBe("secret-token");

    if (isWindows) return;
    const stat = await fs.stat(path.join(home, "credentials"));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("没有写过时返回 null", async () => {
    const ctx = fakeContext();
    expect(await readToken(home, ctx)).toBeNull();
  });

  it("权限比 600 宽时读取后改回 600，并提示一行", async () => {
    await writeToken(home, "secret-token");
    if (isWindows) return;
    const filePath = path.join(home, "credentials");
    await fs.chmod(filePath, 0o644);

    let stderr = "";
    const ctx = fakeContext({ stderr: { write: (s) => { stderr += s; } } });
    expect(await readToken(home, ctx)).toBe("secret-token");

    const stat = await fs.stat(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(stderr.trim().length).toBeGreaterThan(0);
  });

  it("platform 为 win32 时不检查也不修复权限，即使文件是 644", async () => {
    await writeToken(home, "secret-token");
    if (isWindows) return; // 用真实文件系统验证“不修复”，在真正的 Windows 上 chmod 本身就没有意义
    const filePath = path.join(home, "credentials");
    await fs.chmod(filePath, 0o644);

    let stderr = "";
    const ctx = fakeContext({ platform: "win32", stderr: { write: (s) => { stderr += s; } } });
    expect(await readToken(home, ctx)).toBe("secret-token");

    const stat = await fs.stat(filePath);
    expect(stat.mode & 0o777).toBe(0o644);
    expect(stderr).toBe("");
  });
});

describe("clearMachineIdentity", () => {
  let home: string;

  beforeEach(async () => {
    home = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "kh-home-")), ".kanban-hub");
  });

  afterEach(async () => {
    await fs.rm(path.dirname(home), { recursive: true, force: true });
  });

  it("删除凭据，配置里只剩 server", async () => {
    await writeToken(home, "secret-token");
    await writeMachineConfig(home, { server: "https://kh.example.com", machineId: "m000000001", machineName: "my-mac" });

    await clearMachineIdentity(home);

    const ctx = fakeContext();
    expect(await readToken(home, ctx)).toBeNull();
    expect(await readMachineConfig(home)).toEqual({ server: "https://kh.example.com" });
  });

  it("配置不存在时只删凭据", async () => {
    await writeToken(home, "secret-token");
    await clearMachineIdentity(home);

    const ctx = fakeContext();
    expect(await readToken(home, ctx)).toBeNull();
    expect(await readMachineConfig(home)).toBeNull();
  });

  it("凭据和配置都不存在时视为成功", async () => {
    await expect(clearMachineIdentity(home)).resolves.toBeUndefined();
  });

  it("幂等：连续调用两次结果一致", async () => {
    await writeToken(home, "secret-token");
    await writeMachineConfig(home, { server: "https://kh.example.com", machineId: "m000000001", machineName: "my-mac" });

    await clearMachineIdentity(home);
    await clearMachineIdentity(home);

    const ctx = fakeContext();
    expect(await readToken(home, ctx)).toBeNull();
    expect(await readMachineConfig(home)).toEqual({ server: "https://kh.example.com" });
  });
});
