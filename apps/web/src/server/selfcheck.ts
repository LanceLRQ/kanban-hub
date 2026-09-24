import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { resolveServerPaths, type ServerPaths } from "./paths";

const execFileAsync = promisify(execFile);

function chownHint(dir: string, inContainer: boolean): string {
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  if (inContainer) {
    return `请在宿主机上确认对应 ${dir} 的挂载目录已经建好，并执行：sudo chown -R ${uid}:${gid} <该目录>`;
  }
  return `请确认当前用户对 ${dir} 有写权限，例如执行：sudo chown -R ${uid}:${gid} ${dir}`;
}

/**
 * 数据目录必须是绝对路径：standalone 的 server.js 启动时会切换工作目录，
 * 相对路径会指到构建产物所在的目录。有问题返回错误信息，没问题返回 null。
 */
export function checkAbsolutePath(envName: string, dir: string): string | null {
  if (path.isAbsolute(dir)) return null;
  return `${envName} 必须是绝对路径（当前为“${dir}”）：服务启动时会切换工作目录，相对路径会指到构建产物所在的目录`;
}

/** 检查目录存在且可写；create 为 true 时目录不存在就自动创建。有问题返回错误信息，没问题返回 null。 */
export async function checkWritableDir(
  dir: string,
  opts: { create: boolean; inContainer?: boolean },
): Promise<string | null> {
  const inContainer = opts.inContainer ?? false;
  try {
    const st = await fs.stat(dir);
    if (!st.isDirectory()) return `${dir} 不是目录`;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      return `无法访问 ${dir}：${(e as Error).message}`;
    }
    if (!opts.create) return `目录 ${dir} 不存在。${chownHint(dir, inContainer)}`;
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
    return `目录 ${dir} 不可写。${chownHint(dir, inContainer)}`;
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
  // 相对路径先报出来，不去创建或探测它
  const pathErrors = [
    checkAbsolutePath("KH_DATA_DIR", paths.dataDir),
    checkAbsolutePath("KH_BACKUP_DIR", paths.backupDir),
  ].filter((r): r is string => r !== null);
  if (pathErrors.length > 0) return pathErrors;

  const dirOpts = { create: !paths.inContainer, inContainer: paths.inContainer };
  const results = await Promise.all([
    checkWritableDir(paths.dataDir, dirOpts),
    checkWritableDir(paths.backupDir, dirOpts),
    checkGitAvailable(gitBin),
  ]);
  return results.filter((r): r is string => r !== null);
}

/**
 * 启动时调用：自检不通过就打印原因并退出进程。
 * 进程相关的 Node API 放在这个模块里，instrumentation.ts 只做动态导入，
 * 否则 Turbopack 会把它们当作 Edge Runtime 代码告警。
 */
export async function enforceSelfCheck(paths: ServerPaths = resolveServerPaths()): Promise<void> {
  const errors = await runSelfCheck(paths);
  if (errors.length === 0) return;
  for (const msg of errors) console.error(`[kanban-hub] 启动自检失败：${msg}`);
  process.exit(1);
}
