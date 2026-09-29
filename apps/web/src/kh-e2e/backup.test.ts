/**
 * kh backup 的端到端测试：用进程内测试服务端（真实路由处理函数 + 临时存储）驱动 cli 的
 * main()，验证创建、下载落盘、zip 内容，以及各条错误路径的提示与退出码。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlobReader, TextWriter, ZipReader, type Entry, type FileEntry } from "@zip.js/zip.js";
import { writeToken } from "../../../../packages/cli/src/config/home";
import { main } from "../../../../packages/cli/src/main";
import { formatSize } from "../../../../packages/cli/src/commands/backup";
import { startTestServer, type TestServer } from "../server/api/test-server";
import {
  cleanupAll,
  loginFixture,
  makeKhContext,
  makeTempKhHome,
  makeTempRepo,
  runKh,
  type RunKhResult,
  type TempDir,
  type TempRepo,
} from "./harness";

/** 从成功输出里提取保存路径（“已保存到 <路径>（<大小>）”） */
function savedPath(stdout: string): string {
  const match = /已保存到 (.+)（/.exec(stdout);
  if (!match) throw new Error(`输出里没有保存路径：${stdout}`);
  return match[1]!;
}

/** 读一份备份 zip：条目名列表与 manifest 内容；password 传 undefined 表示不加密 */
async function readBackupZip(
  file: string,
  password?: string,
): Promise<{ names: string[]; manifest: Record<string, unknown> }> {
  const bytes = await fs.readFile(file);
  const zip = new ZipReader(new BlobReader(new Blob([new Uint8Array(bytes)])), { password });
  try {
    const entries = await zip.getEntries();
    const manifestEntry = entries.find((e) => e.filename === "manifest.json");
    if (!manifestEntry) throw new Error("备份里没有 manifest.json");
    const manifest = JSON.parse(await (manifestEntry as FileEntry).getData(new TextWriter())) as Record<string, unknown>;
    return { names: entries.map((e: Entry) => e.filename).sort(), manifest };
  } finally {
    await zip.close();
  }
}

/**
 * 交互执行 kh backup：分批喂两遍密码。readline 打开行编辑后一次只消费一行，
 * 一条管道里同时塞两行会被第一遍读走并丢掉第二行（真实终端逐行输入没有这个问题）。
 * password 省略时按两次直接回车处理（不加密）；fetch 透传给 ctx，供个别用例包装请求。
 */
async function runBackupInteractive(
  args: string[],
  opts: { cwd: string; khHome: string; password?: string; fetch?: typeof fetch },
): Promise<RunKhResult> {
  const { ctx, output } = makeKhContext({ cwd: opts.cwd, khHome: opts.khHome, isTTY: true, fetch: opts.fetch });
  const stdin = new PassThrough();
  ctx.stdin = stdin;
  const done = main(args, ctx).then((code) => ({ code, ...output() }));
  await waitForPrompt(output, "设置备份密码");
  stdin.write(`${opts.password ?? ""}\n`);
  await waitForPrompt(output, "再输入一次");
  stdin.write(`${opts.password ?? ""}\n`);
  return done;
}

function waitForPrompt(output: () => { stdout: string }, text: string): Promise<void> {
  return vi.waitFor(() => expect(output().stdout).toContain(text), { timeout: 5000 });
}

describe("kh backup", () => {
  let server: TestServer;
  let khHome: TempDir;
  let cwd: TempRepo;

  beforeEach(async () => {
    server = await startTestServer();
    khHome = await makeTempKhHome();
    cwd = await makeTempRepo({ git: false });
    await loginFixture(server, cwd, khHome);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await cleanupAll(khHome, cwd);
    await server.close();
  });

  it("创建加密备份并下载到当前目录：zip 用同一密码可读，输出里不出现密码", async () => {
    const result = await runBackupInteractive(["backup"], { cwd: cwd.dir, khHome: khHome.dir, password: "秘密密码" });

    expect(result.code).toBe(0);
    expect(result.stdout + result.stderr).not.toContain("秘密密码");
    const saved = savedPath(result.stdout);
    expect(path.dirname(saved)).toBe(cwd.dir);

    const { names, manifest } = await readBackupZip(saved, "秘密密码");
    expect(manifest.format).toBe("kanban-hub-backup");
    expect(names).toContain("manifest.json");
    expect(names.some((n) => n.startsWith("data/"))).toBe(true);

    // 打印的大小与落盘文件一致
    const stat = await fs.stat(saved);
    expect(result.stdout).toContain(formatSize(stat.size));

    // 下载走 <正式名>.part 临时文件 + 完成后改名：目录里只有正式文件，无临时残留
    expect(await fs.readdir(cwd.dir)).toEqual([path.basename(saved)]);
  });

  it("默认备份包含数据目录的 git 历史；两遍都直接回车时不加密", async () => {
    const result = await runBackupInteractive(["backup"], { cwd: cwd.dir, khHome: khHome.dir });

    expect(result.code).toBe(0);
    const { names, manifest } = await readBackupZip(savedPath(result.stdout));
    expect(names.some((n) => n.startsWith("data/.git/"))).toBe(true);
    expect(manifest.includeGit).toBe(true);
  });

  it("--no-history 的备份不含 git 历史", async () => {
    const result = await runBackupInteractive(["backup", "--no-history"], { cwd: cwd.dir, khHome: khHome.dir });

    expect(result.code).toBe(0);
    const { names, manifest } = await readBackupZip(savedPath(result.stdout));
    expect(names.some((n) => n.startsWith("data/.git/"))).toBe(false);
    expect(manifest.includeGit).toBe(false);
  });

  it("服务端已有备份在进行中时提示稍后再试，退出码 5", async () => {
    vi.spyOn(server.api.store, "backupRunning").mockReturnValue(true);

    const result = await runBackupInteractive(["backup"], { cwd: cwd.dir, khHome: khHome.dir });

    expect(result.code).toBe(5);
    expect(result.stderr).toContain("另一个备份正在进行");
  });

  it("没有交互终端时报用法错误，退出码 2", async () => {
    const result = await runKh(["backup"], { cwd: cwd.dir, khHome: khHome.dir });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("终端");
  });

  it("令牌失效时退出码 3", async () => {
    // 格式合法但服务端不认识的令牌（writeToken 会先校验本机格式）；走交互路径让请求真的发出去
    await writeToken(khHome.dir, `kh_${"z".repeat(43)}`);

    const result = await runBackupInteractive(["backup"], { cwd: cwd.dir, khHome: khHome.dir });

    expect(result.code).toBe(3);
  });

  it("下载与当前目录文件同名时依次加 -1、-2 后缀", async () => {
    // 冻结时钟：服务端每次同秒创建的备份名可预期（原名、-1、-2 由服务端自己加），当前目录
    // 里预占下一次的下载名，验证 kh 落盘时的改名规则
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-09-29T10:00:00") });

    const first = await runBackupInteractive(["backup"], { cwd: cwd.dir, khHome: khHome.dir });
    expect(first.code).toBe(0);
    const base = path.basename(savedPath(first.stdout));
    expect(base).toMatch(/^kanban-hub-\d{8}-\d{6}\.zip$/);
    const stem = base.slice(0, -".zip".length);

    await fs.copyFile(path.join(cwd.dir, base), path.join(cwd.dir, `${stem}-1.zip`));
    const second = await runBackupInteractive(["backup"], { cwd: cwd.dir, khHome: khHome.dir });
    expect(second.code).toBe(0);
    expect(path.basename(savedPath(second.stdout))).toBe(`${stem}-1-1.zip`);

    await fs.copyFile(path.join(cwd.dir, base), path.join(cwd.dir, `${stem}-2.zip`));
    await fs.copyFile(path.join(cwd.dir, base), path.join(cwd.dir, `${stem}-2-1.zip`));
    const third = await runBackupInteractive(["backup"], { cwd: cwd.dir, khHome: khHome.dir });
    expect(third.code).toBe(0);
    expect(path.basename(savedPath(third.stdout))).toBe(`${stem}-2-2.zip`);
  });

  it("下载中途断开：不落半截文件，临时文件一并清理，退出码 4", async () => {
    // 包装 fetch：创建请求照常走真实服务端；下载响应先推一段字节再断流，模拟传输中断
    const inner = globalThis.fetch.bind(globalThis);
    const brokenDownload: typeof fetch = async (input, init) => {
      const response = await inner(input, init);
      const pathname = new URL(String(input)).pathname;
      if (response.ok && pathname.startsWith("/api/v1/backups/")) {
        const stream = new Readable({ read() {} });
        stream.push(Buffer.from([0x50, 0x4b]));
        queueMicrotask(() => stream.destroy(new Error("模拟传输中断")));
        return new Response(Readable.toWeb(stream) as unknown as BodyInit, {
          status: response.status,
          headers: response.headers,
        });
      }
      return response;
    };

    const result = await runBackupInteractive(["backup"], { cwd: cwd.dir, khHome: khHome.dir, fetch: brokenDownload });

    expect(result.code).toBe(4);
    expect(result.stderr).toContain("下载中断");
    // 正式名从头到尾没被占用，半截内容也不留在任何文件里
    expect(await fs.readdir(cwd.dir)).toEqual([]);
  });

  it("本地写失败（当前目录只读）退出码 1，报无法写入文件", async () => {
    const readOnly = await makeTempRepo({ git: false });
    try {
      await fs.chmod(readOnly.dir, 0o500);
      const result = await runBackupInteractive(["backup"], { cwd: readOnly.dir, khHome: khHome.dir });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("无法写入文件");
    } finally {
      await fs.chmod(readOnly.dir, 0o700);
      await readOnly.cleanup();
    }
  });
});
