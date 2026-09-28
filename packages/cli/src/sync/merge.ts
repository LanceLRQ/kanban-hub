/**
 * 拉取与冲突处理用到的 git 比较命令：三方合并（git merge-file）与双方差异（git diff --no-index）。
 * 内容一律按字节处理；三方合并的输入写进系统临时目录里的独立子目录，用完即删，
 * 不在仓库里、也不在 KH_HOME 里留下任何东西（kh pull --dry-run 的试算也走这里）。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CliContext } from "../context";
import { CliError, EXIT } from "../errors";
import { runGit } from "../repo/git";

export type MergeResult = { clean: true; merged: Uint8Array } | { clean: false };

export interface MergeLabels {
  local: string;
  base: string;
  remote: string;
}

/** 在系统临时目录建一个独立子目录，把三份内容写进去交给 fn，结束后整个删掉 */
async function withMergeInputs<T>(
  local: Uint8Array,
  base: Uint8Array,
  remote: Uint8Array,
  fn: (dir: string, files: { local: string; base: string; remote: string }) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kh-merge-"));
  try {
    const files = {
      local: path.join(dir, "local"),
      base: path.join(dir, "base"),
      remote: path.join(dir, "remote"),
    };
    await fs.writeFile(files.local, local);
    await fs.writeFile(files.base, base);
    await fs.writeFile(files.remote, remote);
    return await fn(dir, files);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * git merge-file 的退出码：0 没有冲突；1–127 是冲突块的数量（超过 127 按 127 计）；
 * 其余都是执行失败：包括内部错误（经进程退出码表现为 255），以及 runGit 在进程被信号杀掉、
 * 输出超过上限时给出的负数。
 */
function isConflictCount(code: number): boolean {
  return code >= 1 && code <= 127;
}

function mergeFailed(stderr: string): CliError {
  const detail = stderr.trim();
  return new CliError(EXIT.UNEXPECTED, `git merge-file 执行失败${detail !== "" ? `：${detail}` : ""}`);
}

/**
 * 三方合并（git merge-file -p）：没有重叠的改动时返回合并结果，有重叠时返回 clean: false。
 * 调用方负责事先排除二进制内容。
 */
export async function mergeText(ctx: CliContext, local: Uint8Array, base: Uint8Array, remote: Uint8Array): Promise<MergeResult> {
  return withMergeInputs(local, base, remote, async (dir, files) => {
    const result = await runGit(["merge-file", "-p", files.local, files.base, files.remote], {
      cwd: dir,
      env: ctx.env,
      buffer: true,
    });
    if (result.code === 0) return { clean: true, merged: new Uint8Array(result.stdout) };
    if (isConflictCount(result.code)) return { clean: false };
    throw mergeFailed(result.stderr);
  });
}

/**
 * 带冲突标记的三方合并结果（git merge-file -p --diff3）：<<<<<<< / ||||||| / ======= / >>>>>>>
 * 分别标上本机、共同基准、对方机器的标签。有没有冲突都返回合并输出。
 */
export async function diff3Text(
  ctx: CliContext,
  local: Uint8Array,
  base: Uint8Array,
  remote: Uint8Array,
  labels: MergeLabels,
): Promise<Uint8Array> {
  return withMergeInputs(local, base, remote, async (dir, files) => {
    const result = await runGit(
      [
        "merge-file",
        "-p",
        "--diff3",
        "-L",
        labels.local,
        "-L",
        labels.base,
        "-L",
        labels.remote,
        files.local,
        files.base,
        files.remote,
      ],
      { cwd: dir, env: ctx.env, buffer: true },
    );
    if (result.code === 0 || isConflictCount(result.code)) return new Uint8Array(result.stdout);
    throw mergeFailed(result.stderr);
  });
}

/**
 * 两个文件的差异（git diff --no-index）：退出码 1 表示有差异，不算失败。
 * 关掉外部 diff 工具和颜色，输出不受本机 git 配置影响。
 */
export async function diffNoIndex(ctx: CliContext, localPath: string, remotePath: string): Promise<Uint8Array> {
  const result = await runGit(["diff", "--no-index", "--no-ext-diff", "--no-color", "--", localPath, remotePath], {
    cwd: path.dirname(remotePath),
    env: ctx.env,
    buffer: true,
  });
  if (result.code === 0 || result.code === 1) return new Uint8Array(result.stdout);
  const detail = result.stderr.trim();
  throw new CliError(EXIT.UNEXPECTED, `git diff 执行失败${detail !== "" ? `：${detail}` : ""}`);
}
