import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CliContext } from "../context";
import { EXIT, type CliError } from "../errors";
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
/** 测试用的合法机器令牌：kh_ 加 43 位 [A-Za-z0-9_-] */
const FAKE_TOKEN = `kh_${"a".repeat(43)}`;

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

  it("server 不是合法的服务端地址（本机配置被手改坏）时抛用法错误（2），不是英文的 Invalid URL", async () => {
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(home, "config.yaml"), "server: 不是网址\n", "utf8");

    const err = await readMachineConfig(home).catch((e: unknown) => e);
    expect(err).toMatchObject({ exitCode: EXIT.USAGE });
    expect((err as Error).message).not.toContain("Invalid URL");
  });

  it("server 带用户名密码（本机配置被手改坏）时抛用法错误（2），不回显密码", async () => {
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(home, "config.yaml"), "server: http://user:hunter2@evil.test\n", "utf8");

    const err = await readMachineConfig(home).catch((e: unknown) => e);
    expect(err).toMatchObject({ exitCode: EXIT.USAGE });
    expect((err as Error).message).not.toContain("hunter2");
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
    await writeToken(home, FAKE_TOKEN);
    const ctx = fakeContext();
    expect(await readToken(home, ctx)).toBe(FAKE_TOKEN);

    if (isWindows) return;
    const stat = await fs.stat(path.join(home, "credentials"));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("没有写过时返回 null", async () => {
    const ctx = fakeContext();
    expect(await readToken(home, ctx)).toBeNull();
  });

  it("权限比 600 宽时读取后改回 600，并提示一行", async () => {
    await writeToken(home, FAKE_TOKEN);
    if (isWindows) return;
    const filePath = path.join(home, "credentials");
    await fs.chmod(filePath, 0o644);

    let stderr = "";
    const ctx = fakeContext({ stderr: { write: (s) => { stderr += s; } } });
    expect(await readToken(home, ctx)).toBe(FAKE_TOKEN);

    const stat = await fs.stat(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(stderr.trim().length).toBeGreaterThan(0);
  });

  it("platform 为 win32 时不检查也不修复权限，即使文件是 644", async () => {
    await writeToken(home, FAKE_TOKEN);
    if (isWindows) return; // 用真实文件系统验证“不修复”，在真正的 Windows 上 chmod 本身就没有意义
    const filePath = path.join(home, "credentials");
    await fs.chmod(filePath, 0o644);

    let stderr = "";
    const ctx = fakeContext({ platform: "win32", stderr: { write: (s) => { stderr += s; } } });
    expect(await readToken(home, ctx)).toBe(FAKE_TOKEN);

    const stat = await fs.stat(filePath);
    expect(stat.mode & 0o777).toBe(0o644);
    expect(stderr).toBe("");
  });

  it("writeToken 拒绝格式不对的令牌，不写文件", async () => {
    await expect(writeToken(home, "not-a-valid-token")).rejects.toThrowError(
      expect.objectContaining({ exitCode: EXIT.UNEXPECTED }),
    );
    await expect(fs.stat(path.join(home, "credentials"))).rejects.toThrow();
  });

  it("readToken 读到格式不对的内容时抛 CliError(2)，不回显文件内容", async () => {
    await fs.mkdir(home, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(home, "credentials"), "not-a-valid-token\n", { mode: 0o600 });
    const ctx = fakeContext();
    const err = await readToken(home, ctx).catch((e: unknown) => e);
    expect(err).toMatchObject({ exitCode: EXIT.USAGE });
    expect((err as Error).message).not.toContain("not-a-valid-token");
  });

  it("readToken 读到坏格式时，本机配置里有服务端地址就提示 /setup（不是 kh login 的位置参数写法）", async () => {
    await writeMachineConfig(home, { server: "https://kh.example.com", machineId: "m000000001", machineName: "my-mac" });
    await fs.writeFile(path.join(home, "credentials"), "not-a-valid-token\n", { mode: 0o600 });
    const ctx = fakeContext();
    const err = await readToken(home, ctx).catch((e: unknown) => e);
    expect((err as CliError).exitCode).toBe(EXIT.USAGE);
    expect((err as CliError).hint).toBe("到 https://kh.example.com/setup 取配对码，再执行 kh login --code <配对码>");
  });

  it("readToken 读到坏格式时，本机配置里没有服务端地址就给出带 --server 的完整命令", async () => {
    await fs.mkdir(home, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(home, "credentials"), "not-a-valid-token\n", { mode: 0o600 });
    const ctx = fakeContext();
    const err = await readToken(home, ctx).catch((e: unknown) => e);
    expect((err as CliError).exitCode).toBe(EXIT.USAGE);
    expect((err as CliError).hint).toBe("kh login --server <地址> --code <配对码>");
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
    await writeToken(home, FAKE_TOKEN);
    await writeMachineConfig(home, { server: "https://kh.example.com", machineId: "m000000001", machineName: "my-mac" });

    await clearMachineIdentity(home);

    const ctx = fakeContext();
    expect(await readToken(home, ctx)).toBeNull();
    expect(await readMachineConfig(home)).toEqual({ server: "https://kh.example.com" });
  });

  it("配置不存在时只删凭据", async () => {
    await writeToken(home, FAKE_TOKEN);
    await clearMachineIdentity(home);

    const ctx = fakeContext();
    expect(await readToken(home, ctx)).toBeNull();
    expect(await readMachineConfig(home)).toBeNull();
  });

  it("凭据和配置都不存在时视为成功", async () => {
    await expect(clearMachineIdentity(home)).resolves.toBeUndefined();
  });

  it("幂等：连续调用两次结果一致", async () => {
    await writeToken(home, FAKE_TOKEN);
    await writeMachineConfig(home, { server: "https://kh.example.com", machineId: "m000000001", machineName: "my-mac" });

    await clearMachineIdentity(home);
    await clearMachineIdentity(home);

    const ctx = fakeContext();
    expect(await readToken(home, ctx)).toBeNull();
    expect(await readMachineConfig(home)).toEqual({ server: "https://kh.example.com" });
  });
});
