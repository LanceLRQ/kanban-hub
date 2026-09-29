import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { KH_VERSION } from "@kanban-hub/core/version";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BACKUP_FORMAT, BACKUP_FORMAT_VERSION, writeBackupArchive, type BackupManifest } from "./server/store/backup";
import { main, parseArgs, UsageError, type CliIo } from "./restore";

const execFileAsync = promisify(execFile);

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "kh-restore-cli-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

// ---------- 测试夹具 ----------

/** 建一个有内容的数据目录，并打出一份备份 zip */
async function makeBackup(opts: { password?: string; includeGit?: boolean } = {}): Promise<{ file: string; manifest: BackupManifest }> {
  const dataDir = path.join(root, "src-data");
  await fs.mkdir(path.join(dataDir, "auth"), { recursive: true });
  await fs.writeFile(path.join(dataDir, "board.yaml"), "containers: []\n");
  await fs.writeFile(path.join(dataDir, "auth", "users.yaml"), "users: []\n");
  const backupDir = path.join(root, "backups");
  const info = await writeBackupArchive(dataDir, backupDir, {
    password: opts.password,
    includeGit: opts.includeGit,
    now: () => new Date("2026-09-29T10:00:00.000Z"),
  });
  return {
    file: path.join(backupDir, info.fileName),
    manifest: {
      format: BACKUP_FORMAT,
      version: BACKUP_FORMAT_VERSION,
      createdAt: "2026-09-29T10:00:00.000Z",
      includeGit: opts.includeGit ?? true,
      khVersion: KH_VERSION,
    },
  };
}

/** 测试里手工拼一个 zip：用来造含越界条目的坏备份 */
async function writeCraftedZip(file: string, entries: Array<{ name: string; content: string }>): Promise<void> {
  const sink = new Uint8ArrayWriter();
  const writer = new ZipWriter(sink);
  for (const entry of entries) await writer.add(entry.name, new TextReader(entry.content));
  await writer.close();
  await fs.writeFile(file, await sink.getData());
}

function manifestText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: BACKUP_FORMAT,
    version: BACKUP_FORMAT_VERSION,
    createdAt: "2026-09-29T10:00:00.000Z",
    includeGit: true,
    khVersion: KH_VERSION,
    ...overrides,
  });
}

// ---------- 进程流替身 ----------

type TestStdin = PassThrough & { isTTY?: boolean };

/** 收集写入内容的可写流，测试结束前同步可读 */
function collecting(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  let text = "";
  stream.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  return { stream, text: () => text };
}

function makeIo(opts: { tty?: boolean; stdin?: string; env?: Record<string, string | undefined>; rawMode?: boolean } = {}) {
  const stdin: TestStdin = new PassThrough();
  if (opts.tty) stdin.isTTY = true;
  // 记录 raw 模式的开与关：取消路径必须把终端恢复回原状态
  const rawModes: boolean[] = [];
  if (opts.rawMode) {
    (stdin as TestStdin & { setRawMode: (mode: boolean) => void }).setRawMode = (mode: boolean) => {
      rawModes.push(mode);
    };
  }
  if (opts.stdin !== undefined) stdin.write(opts.stdin);
  const out = collecting();
  const err = collecting();
  const io: CliIo = { stdin, stdout: out.stream, stderr: err.stream, env: opts.env ?? {} };
  return { io, out: out.text, err: err.text, rawModes };
}

// ---------- 参数解析 ----------

describe("parseArgs", () => {
  it("解析备份文件与全部选项", () => {
    expect(parseArgs(["a.zip", "--data-dir", "/tmp/d", "--password", "pw", "--yes"])).toEqual({
      backupFile: "a.zip",
      dataDir: "/tmp/d",
      password: "pw",
      yes: true,
      help: false,
    });
  });

  it("支持 --选项=值 的等号写法", () => {
    expect(parseArgs(["a.zip", "--data-dir=/tmp/d"])).toMatchObject({ dataDir: "/tmp/d" });
    expect(parseArgs(["a.zip", "--password=pw"])).toMatchObject({ password: "pw" });
  });

  it("--help 不要求备份文件", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  it("一个参数都没有时报用法错误", () => {
    expect(() => parseArgs([])).toThrow(UsageError);
  });

  it("缺少备份文件时报用法错误", () => {
    expect(() => parseArgs(["--yes"])).toThrow(UsageError);
  });

  it("未知选项报用法错误", () => {
    expect(() => parseArgs(["a.zip", "--force"])).toThrow(UsageError);
  });

  it("选项缺少参数值报用法错误", () => {
    expect(() => parseArgs(["a.zip", "--data-dir"])).toThrow(UsageError);
    expect(() => parseArgs(["a.zip", "--password"])).toThrow(UsageError);
  });

  it("多余的位置参数报用法错误", () => {
    expect(() => parseArgs(["a.zip", "b.zip"])).toThrow(UsageError);
  });
});

// ---------- 主流程 ----------

describe("main", () => {
  it("空目录加 --yes：恢复成功，打印 manifest 摘要、写入文件数与是否含历史", async () => {
    const { file, manifest } = await makeBackup();
    const target = path.join(root, "target");
    const { io, out, err } = makeIo();

    await expect(main([file, "--data-dir", target, "--yes"], io)).resolves.toBe(0);

    expect(err()).toBe("");
    expect(out()).toContain(manifest.createdAt);
    expect(out()).toContain("含 git 历史：是");
    expect(out()).toContain(`备份时版本：${KH_VERSION}`);
    expect(out()).toContain(`恢复完成：写入 2 个文件`);
    expect(out()).toContain("包含 git 历史");
    expect(await fs.readFile(path.join(target, "board.yaml"), "utf8")).toBe("containers: []\n");
    expect(await fs.readFile(path.join(target, "auth", "users.yaml"), "utf8")).toBe("users: []\n");
    // manifest 只是元数据，不落进数据目录
    expect(await fs.readdir(target)).not.toContain("manifest.json");
    expect(await fs.readdir(target)).not.toContain(".restore-tmp");
  });

  it("备份不含 git 历史时如实说明", async () => {
    const { file } = await makeBackup({ includeGit: false });
    const { io, out } = makeIo();

    await expect(main([file, "--data-dir", path.join(root, "t"), "--yes"], io)).resolves.toBe(0);
    expect(out()).toContain("含 git 历史：否");
    expect(out()).toContain("不包含 git 历史");
  });

  it("目标目录非空：失败退出码 1，错误信息说明只能恢复到空目录", async () => {
    const { file } = await makeBackup();
    const target = path.join(root, "not-empty");
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "keep.txt"), "原有内容");
    const { io, out, err } = makeIo();

    await expect(main([file, "--data-dir", target, "--yes"], io)).resolves.toBe(1);

    // 摘要在恢复尝试之前打印，冲突发生在恢复这一步
    expect(out()).not.toContain("恢复完成");
    expect(err()).toContain("只能恢复到空目录");
    expect(await fs.readFile(path.join(target, "keep.txt"), "utf8")).toBe("原有内容");
  });

  it("密码错误：退出码 1，提示密码问题但不回显任何一方密码", async () => {
    const right = "正确的密码";
    const wrong = "错误的密码";
    const { file } = await makeBackup({ password: right });
    const { io, err } = makeIo();

    await expect(main([file, "--data-dir", path.join(root, "t"), "--password", wrong, "--yes"], io)).resolves.toBe(1);

    expect(err()).toContain("密码");
    expect(err()).not.toContain(right);
    expect(err()).not.toContain(wrong);
  });

  it("带 .. 段的备份拒绝恢复，目标目录保持为空", async () => {
    const file = path.join(root, "evil.zip");
    await writeCraftedZip(file, [
      { name: "manifest.json", content: manifestText() },
      { name: "data/keep.txt", content: "正常的" },
      { name: "data/../../escape.txt", content: "越界" },
    ]);
    const target = path.join(root, "target");
    const { io, err } = makeIo();

    await expect(main([file, "--data-dir", target, "--yes"], io)).resolves.toBe(1);

    // zip.js 在读条目阶段就拒绝不安全文件名，报错是中文包装，不会落任何文件
    expect(err()).toContain("备份");
    expect(await fs.readdir(target).catch(() => [])).toEqual([]);
  });

  it("manifest 之外的根下条目拒绝恢复，目标目录保持为空", async () => {
    const file = path.join(root, "stray.zip");
    await writeCraftedZip(file, [
      { name: "manifest.json", content: manifestText() },
      { name: "data/keep.txt", content: "正常的" },
      { name: "stray.txt", content: "根下多余文件" },
    ]);
    const target = path.join(root, "target");
    const { io, err } = makeIo();

    await expect(main([file, "--data-dir", target, "--yes"], io)).resolves.toBe(1);

    expect(err()).toContain("拒绝");
    expect(await fs.readdir(target).catch(() => [])).toEqual([]);
  });

  it("备份文件不存在：退出码 1，提示文件不存在", async () => {
    const { io, err } = makeIo();
    await expect(main([path.join(root, "没有.zip"), "--data-dir", path.join(root, "t"), "--yes"], io)).resolves.toBe(1);
    expect(err()).toContain("备份文件不存在");
  });

  it("非终端且没有 --yes：拒绝执行（退出码 2）并附用法，目标目录未动", async () => {
    const { file } = await makeBackup();
    const target = path.join(root, "target");
    const { io, err } = makeIo({ tty: false });

    await expect(main([file, "--data-dir", target], io)).resolves.toBe(2);

    expect(err()).toContain("--yes");
    expect(err()).toContain("用法");
    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("终端里密码输入中按 Ctrl-C：取消并以退出码 1 结束，终端恢复非 raw 模式", async () => {
    const { file } = await makeBackup();
    const target = path.join(root, "target");
    const { io, out, err, rawModes } = makeIo({ tty: true, stdin: "\u0003", rawMode: true });

    await expect(main([file, "--data-dir", target, "--yes"], io)).resolves.toBe(1);

    expect(err()).toContain("已取消");
    // raw 先开后关：终端状态被恢复
    expect(rawModes).toEqual([true, false]);
    expect(out()).not.toContain("恢复完成");
    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("加密备份在非终端下没有密码来源：以解密失败退出", async () => {
    const { file } = await makeBackup({ password: "pw" });
    const { io, err } = makeIo({ tty: false });

    await expect(main([file, "--data-dir", path.join(root, "t"), "--yes"], io)).resolves.toBe(1);
    expect(err()).toContain("密码");
  });

  it("KH_RESTORE_PASSWORD 作为密码来源能解开加密备份", async () => {
    const { file } = await makeBackup({ password: "环境变量密码" });
    const { io, out } = makeIo({ env: { KH_RESTORE_PASSWORD: "环境变量密码" } });

    await expect(main([file, "--data-dir", path.join(root, "t"), "--yes"], io)).resolves.toBe(0);
    expect(out()).toContain("恢复完成");
  });

  it("--password 优先于 KH_RESTORE_PASSWORD", async () => {
    const { file } = await makeBackup({ password: "正确的密码" });
    const { io } = makeIo({ env: { KH_RESTORE_PASSWORD: "错误的密码" } });

    await expect(main([file, "--data-dir", path.join(root, "t"), "--password", "正确的密码", "--yes"], io)).resolves.toBe(0);
  });

  it("未指定 --data-dir 时取 KH_DATA_DIR", async () => {
    const { file } = await makeBackup();
    const target = path.join(root, "env-target");
    const { io } = makeIo({ env: { KH_DATA_DIR: target } });

    await expect(main([file, "--yes"], io)).resolves.toBe(0);
    expect(await fs.readFile(path.join(target, "board.yaml"), "utf8")).toBe("containers: []\n");
  });

  it("终端里先回车跳过密码再回答 y 确认恢复", async () => {
    const { file } = await makeBackup();
    const target = path.join(root, "target");
    const { io, out } = makeIo({ tty: true, stdin: "\ny\n" });

    await expect(main([file, "--data-dir", target], io)).resolves.toBe(0);
    expect(out()).toContain("恢复完成");
    expect(await fs.readFile(path.join(target, "board.yaml"), "utf8")).toBe("containers: []\n");
  });

  it("终端里回答其他内容取消：退出码 1，目标目录未动", async () => {
    const { file } = await makeBackup();
    const target = path.join(root, "target");
    const { io, err } = makeIo({ tty: true, stdin: "\nn\n" });

    await expect(main([file, "--data-dir", target], io)).resolves.toBe(1);
    expect(err()).toContain("已取消");
    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("终端里交互输入密码：不回显，密码正确则恢复成功", async () => {
    const secret = "交互输入的密码";
    const { file } = await makeBackup({ password: secret });
    const target = path.join(root, "target");
    const { io, out, err } = makeIo({ tty: true, stdin: `${secret}\n` });

    await expect(main([file, "--data-dir", target, "--yes"], io)).resolves.toBe(0);

    expect(out()).not.toContain(secret);
    expect(err()).not.toContain(secret);
    expect(out()).toContain("恢复完成");
    expect(await fs.readFile(path.join(target, "board.yaml"), "utf8")).toBe("containers: []\n");
  });

  it("终端里交互输入空密码：视为备份未加密", async () => {
    const { file } = await makeBackup();
    const target = path.join(root, "target");
    const { io } = makeIo({ tty: true, stdin: "\n" });

    await expect(main([file, "--data-dir", target, "--yes"], io)).resolves.toBe(0);
    expect(await fs.readFile(path.join(target, "board.yaml"), "utf8")).toBe("containers: []\n");
  });

  it("--help 打印用法并以 0 退出", async () => {
    const { io, out } = makeIo();
    await expect(main(["--help"], io)).resolves.toBe(0);
    expect(out()).toContain("用法");
    expect(out()).toContain("--data-dir");
    expect(out()).toContain("--password");
    expect(out()).toContain("--yes");
    // 命令行传密码的副作用必须写进帮助：防人把密码留在 shell 历史里
    expect(out()).toContain("shell 历史");
    expect(out()).toContain("KH_RESTORE_PASSWORD");
  });

  it("用法错误：打印原因与用法，退出码 2", async () => {
    const { io, out, err } = makeIo();
    await expect(main(["--force", "a.zip"], io)).resolves.toBe(2);
    expect(err()).toContain("未知选项");
    expect(err()).toContain("用法");
    expect(out()).toBe("");
  });
});

// ---------- 打包产物冒烟 ----------

/** 产物路径：src/restore.test.ts 的上一级就是 apps/web */
const DIST_RESTORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "restore.mjs");

/** 去掉可能干扰判断的 KH_* 环境变量，冒烟测试用干净环境跑 */
function cleanEnv(): NodeJS.ProcessEnv {
  const { KH_DATA_DIR: _dataDir, KH_RESTORE_PASSWORD: _password, ...rest } = process.env;
  return rest;
}

describe.skipIf(!existsSync(DIST_RESTORE))("打包产物 dist/restore.mjs", () => {
  it("端到端：把真实备份恢复到指定目录", { timeout: 60_000 }, async () => {
    const { file } = await makeBackup();
    const target = path.join(root, "e2e-target");

    const { stdout } = await execFileAsync(
      process.execPath,
      [DIST_RESTORE, file, "--data-dir", target, "--yes"],
      { env: cleanEnv() },
    );

    expect(stdout).toContain("恢复完成");
    expect(await fs.readFile(path.join(target, "board.yaml"), "utf8")).toBe("containers: []\n");
  });

  it("用法错误以退出码 2 结束", { timeout: 60_000 }, async () => {
    await expect(execFileAsync(process.execPath, [DIST_RESTORE], { env: cleanEnv() })).rejects.toMatchObject({
      code: 2,
    });
  });
});
