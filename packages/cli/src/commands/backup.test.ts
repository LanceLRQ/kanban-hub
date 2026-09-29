import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliContext } from "../context";
import { formatSize, readPasswordConfirmed, resolveDownloadTarget, withSuffix } from "./backup";

function fakeContext(overrides: Partial<CliContext> = {}): CliContext {
  return {
    cwd: "/tmp",
    env: {},
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    stdin: new PassThrough(),
    isTTY: true,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    platform: "linux",
    hostname: "test-host",
    homeDir: "/home/test-user",
    fetch: (() => {
      throw new Error("不应该在 backup 单元测试里调用 fetch");
    }) as unknown as typeof fetch,
    ...overrides,
  };
}

let workDir: string;

afterEach(async () => {
  if (workDir) await fs.rm(workDir, { recursive: true, force: true });
  workDir = "";
});

async function makeWorkDir(): Promise<string> {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "kh-backup-cmd-"));
  return workDir;
}

/** 等 readPasswordConfirmed 的提示出现后再喂下一行：readline 一次只消费一行，一次性写两行会被第一条吞掉 */
async function until(cond: () => boolean): Promise<void> {
  await vi.waitFor(() => expect(cond()).toBe(true));
}

describe("withSuffix", () => {
  it("在 .zip 扩展名前加序号", () => {
    expect(withSuffix("kanban-hub-20260929-100000.zip", 1)).toBe("kanban-hub-20260929-100000-1.zip");
    expect(withSuffix("kanban-hub-20260929-100000.zip", 2)).toBe("kanban-hub-20260929-100000-2.zip");
  });

  it("没有扩展名的名字整体加序号", () => {
    expect(withSuffix("backup", 3)).toBe("backup-3");
  });
});

describe("resolveDownloadTarget", () => {
  it("目录里没有同名文件时用原名", async () => {
    const dir = await makeWorkDir();
    await expect(resolveDownloadTarget(dir, "kanban-hub-1.zip")).resolves.toBe("kanban-hub-1.zip");
  });

  it("原名已存在时依次加 -1、-2，直到名字空出来", async () => {
    const dir = await makeWorkDir();
    await fs.writeFile(path.join(dir, "kanban-hub-1.zip"), "x");
    await expect(resolveDownloadTarget(dir, "kanban-hub-1.zip")).resolves.toBe("kanban-hub-1-1.zip");
    await fs.writeFile(path.join(dir, "kanban-hub-1-1.zip"), "x");
    await expect(resolveDownloadTarget(dir, "kanban-hub-1.zip")).resolves.toBe("kanban-hub-1-2.zip");
  });
});

describe("formatSize", () => {
  it("1024 以下按字节，往上按单位换算并保留一位小数", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2.0 KB");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(5 * 1024 ** 3)).toBe("5.0 GB");
  });
});

describe("readPasswordConfirmed", () => {
  it("两遍一致时返回密码，输出里不出现密码", async () => {
    let stdout = "";
    const stdin = new PassThrough();
    const ctx = fakeContext({ stdin, stdout: { write: (s) => { stdout += s; } } });
    const result = readPasswordConfirmed(ctx);

    await until(() => stdout.includes("设置备份密码"));
    stdin.write("abc123\n");
    await until(() => stdout.includes("再输入一次"));
    stdin.write("abc123\n");

    await expect(result).resolves.toBe("abc123");
    expect(stdout).not.toContain("abc123");
  });

  it("两遍不一致时重新问，直到一致", async () => {
    let stdout = "";
    let stderr = "";
    const stdin = new PassThrough();
    const ctx = fakeContext({
      stdin,
      stdout: { write: (s) => { stdout += s; } },
      stderr: { write: (s) => { stderr += s; } },
    });
    const result = readPasswordConfirmed(ctx);

    await until(() => stdout.includes("设置备份密码"));
    stdin.write("first\n");
    await until(() => stdout.includes("再输入一次"));
    stdin.write("second\n");

    // 不一致后重新问：新一轮的两条提示依次出现（每个提示各出现第 2 次）
    await until(() => stderr.includes("两次输入不一致"));
    await until(() => stdout.split("设置备份密码").length >= 3);
    stdin.write("ok\n");
    await until(() => stdout.split("再输入一次").length >= 3);
    stdin.write("ok\n");

    await expect(result).resolves.toBe("ok");
    const all = stdout + stderr;
    expect(all).not.toContain("first");
    expect(all).not.toContain("second");
    expect(all).not.toContain("ok");
  });
});
