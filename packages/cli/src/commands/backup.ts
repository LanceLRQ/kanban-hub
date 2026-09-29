/**
 * kh backup：让服务端把数据目录打包成备份（可选 AES-256 加密），并把备份 zip 下载到当前
 * 目录。密码只从终端交互读取（不回显、不进 shell 历史与进程列表），所以不提供 --password
 * 之类的命令行参数。
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { z } from "zod";
import type { ApiClient } from "../http/client";
import type { CliContext } from "../context";
import { CliError, EXIT } from "../errors";
import { readPassword } from "../prompt";
import { globalAgentFlag, requireLogin, withAgentOption } from "./shared";

/** 创建接口的响应：服务端备份目录里的文件名、字节数与创建时间 */
const backupCreated = z.object({
  fileName: z.string(),
  size: z.number(),
  createdAt: z.string(),
});

interface BackupOptions {
  /** commander 对 --no-history 生成的字段：默认 true，传 --no-history 时为 false */
  history?: boolean;
}

/** 交互读两遍密码；不一致就重新问，直到两遍一致；两遍都直接回车 = 不加密（空串） */
export async function readPasswordConfirmed(ctx: CliContext): Promise<string> {
  for (;;) {
    const first = await readPassword(ctx, "设置备份密码（直接回车则不加密）：");
    const second = await readPassword(ctx, "再输入一次：");
    if (first === second) return first;
    // 提示走 stderr：stdout 只留给命令结果，脚本好解析
    ctx.stderr.write("两次输入不一致，请重新输入\n");
  }
}

/** 给文件名的扩展名前加序号：kanban-hub-x.zip → kanban-hub-x-1.zip */
export function withSuffix(fileName: string, n: number): string {
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : "";
  return `${stem}-${n}${ext}`;
}

/**
 * 下载目标与当前目录已有文件同名时，依次加 -1、-2……直到名字空出来。
 * 与服务端备份目录的同秒处理（server/store/backup.ts 的 resolveBackupPath）保持同一套规则。
 */
export async function resolveDownloadTarget(dir: string, fileName: string): Promise<string> {
  let candidate = fileName;
  for (let n = 1; ; n += 1) {
    try {
      await fs.stat(path.join(dir, candidate));
    } catch {
      return candidate;
    }
    candidate = withSuffix(fileName, n);
  }
}

/** 字节数显示成人读的格式：1024 以下按字节，往上 KB/MB/GB，保留一位小数 */
export function formatSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? String(value) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * 把备份下载流式写进 `<target>.part`，全部写完后再原子改名到正式名。信号杀进程（Ctrl+C、
 * SIGTERM）不走任何 catch/finally，直接写正式名会留下占着正式名的半截 zip——看起来像一份
 * 合法的旧备份，还会把下一次下载挤到 -1。写临时文件后最多残留 .part（不占正式名，且下次
 * 下载开头 open "w" 就把它覆盖掉）；异常路径顺手清掉。改名前先关句柄：Windows 不允许改名
 * 打开中的文件。
 */
async function downloadBackup(client: ApiClient, fileName: string, target: string): Promise<void> {
  const partPath = `${target}.part`;
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(partPath, "w");
  } catch (err) {
    // 本地 I/O 失败不是用法问题，归“意外错误”（1），与写失败同码
    throw new CliError(EXIT.UNEXPECTED, `无法写入文件：${path.basename(target)}`, err instanceof Error ? err.message : undefined);
  }
  let closed = false;
  const closeHandle = async () => {
    if (!closed) {
      closed = true;
      await handle.close();
    }
  };
  try {
    await client.downloadTo(`/api/v1/backups/${encodeURIComponent(fileName)}`, async (chunk) => {
      try {
        await handle.write(chunk);
      } catch (err) {
        // 写盘失败要带上自己的上下文（CliError 会被 downloadTo 原样放行，不会被归成“下载中断”）
        throw new CliError(EXIT.UNEXPECTED, `无法写入文件：${path.basename(target)}`, err instanceof Error ? err.message : undefined);
      }
    });
    await closeHandle();
    await fs.rename(partPath, target);
  } catch (err) {
    await closeHandle();
    // 清理失败不顶掉原始错误：残留的 .part 不占正式名，下次下载会覆盖它
    await fs.rm(partPath, { force: true }).catch(() => {});
    throw err;
  }
}

async function runBackup(ctx: CliContext, opts: BackupOptions, agentFlag?: string): Promise<void> {
  const { client } = await requireLogin(ctx, agentFlag);
  const password = await readPasswordConfirmed(ctx);

  let created: z.output<typeof backupCreated>;
  try {
    created = await client.post("/api/v1/backups", { password: password || undefined, includeGit: opts.history !== false }, backupCreated);
  } catch (err) {
    // 409 是“另一份备份正在创建”的互斥拒绝：服务端的文案面向网页，这里换成命令行的下一步提示
    if (err instanceof CliError && err.status === 409) {
      throw new CliError(err.exitCode, "另一个备份正在进行，稍后再试");
    }
    throw err;
  }

  const target = path.resolve(ctx.cwd, await resolveDownloadTarget(ctx.cwd, created.fileName));
  await downloadBackup(client, created.fileName, target);
  ctx.stdout.write(`已保存到 ${target}（${formatSize(created.size)}）\n`);
}

/** kh backup：创建服务端备份并下载到当前目录 */
export function registerBackup(program: Command, ctx: CliContext): void {
  withAgentOption(
    program
      .command("backup")
      .description("创建服务端备份（可选 AES-256 加密）并下载到当前目录")
      .option("--no-history", "备份不含数据目录的 git 历史"),
  ).action(async (opts: BackupOptions, cmd: Command) => {
    await runBackup(ctx, opts, globalAgentFlag(cmd));
  });
}
