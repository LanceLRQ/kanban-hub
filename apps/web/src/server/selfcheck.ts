import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { resolveServerPaths, type ServerPaths } from "./paths";

const execFileAsync = promisify(execFile);

function chownHint(dir: string): string {
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  return `请在宿主机上确认对应 ${dir} 的挂载目录已经建好，并执行：sudo chown -R ${uid}:${gid} <该目录>`;
}

/** 检查目录存在且可写；create 为 true 时目录不存在就自动创建。有问题返回错误信息，没问题返回 null。 */
export async function checkWritableDir(dir: string, opts: { create: boolean }): Promise<string | null> {
  try {
    const st = await fs.stat(dir);
    if (!st.isDirectory()) return `${dir} 不是目录`;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      return `无法访问 ${dir}：${(e as Error).message}`;
    }
    if (!opts.create) return `目录 ${dir} 不存在。${chownHint(dir)}`;
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (err) {
      return `无法创建目录 ${dir}：${(err as Error).message}`;
    }
  }

  const probe = path.join(dir, `.kh-write-probe-${process.pid}`);
  try {
    await fs.writeFile(probe, "");
    await fs.rm(probe, { force: true });
    return null;
  } catch {
    return `目录 ${dir} 不可写。${chownHint(dir)}`;
  }
}

export async function checkGitAvailable(gitBin = "git"): Promise<string | null> {
  try {
    await execFileAsync(gitBin, ["--version"]);
    return null;
  } catch {
    return `找不到可用的 git 命令（${gitBin}），kanban-hub 需要 git 保存数据历史`;
  }
}

/** 运行全部自检项，返回错误信息列表；空数组表示全部通过。 */
export async function runSelfCheck(paths: ServerPaths, gitBin = "git"): Promise<string[]> {
  const results = await Promise.all([
    checkWritableDir(paths.dataDir, { create: !paths.inContainer }),
    checkWritableDir(paths.backupDir, { create: !paths.inContainer }),
    checkGitAvailable(gitBin),
  ]);
  return results.filter((r): r is string => r !== null);
}

/**
 * 启动时调用：自检不通过就打印原因并退出进程。
 * 进程相关的 Node API 放在这个模块里，instrumentation.ts 只做动态导入，
 * 否则 Turbopack 会把它们当作 Edge Runtime 代码告警。
 */
export async function enforceSelfCheck(): Promise<void> {
  const errors = await runSelfCheck(resolveServerPaths());
  if (errors.length === 0) return;
  for (const msg of errors) console.error(`[kanban-hub] 启动自检失败：${msg}`);
  process.exit(1);
}
