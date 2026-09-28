import fs from "node:fs/promises";
import path from "node:path";

/**
 * 本工具原子写入用的临时文件的完整命名规则：放在目标文件所在目录、以点开头（不出现在
 * 普通的目录列表里），中间是原文件名，方便排查残留文件时能看出它对应哪个目标。
 * 扫描（sync/scan.ts）据此忽略这类文件，不把它们当成同步范围里的内容。
 */
export const KH_TMP_PATTERN = /^\..*\.kh-tmp-\d+-\d+$/;

let tmpSeq = 0;

function tmpPathFor(file: string): string {
  const dir = path.dirname(file);
  const base = path.basename(file);
  return path.join(dir, `.${base}.kh-tmp-${process.pid}-${++tmpSeq}`);
}

export function isNoEntError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === "ENOENT";
}

export interface WriteFileAtomicOptions {
  /** 文件权限位，未指定时用系统默认权限 */
  mode?: number;
  /** true 时先创建目标所在的父目录（recursive），默认要求父目录已存在 */
  mkdir?: boolean;
}

/**
 * 原子写入：先写同目录下的临时文件，成功后再 rename 到目标路径，避免留下写到一半的文件。
 * data 是字符串时按 UTF-8 写入，是字节数组时原样写入（用于二进制内容，例如同步的 blob）。
 * 写入或改名失败时删除临时文件再把原始异常继续抛出。
 */
export async function writeFileAtomic(file: string, data: string | Uint8Array, opts: WriteFileAtomicOptions = {}): Promise<void> {
  if (opts.mkdir) await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = tmpPathFor(file);
  try {
    if (typeof data === "string") {
      await fs.writeFile(tmp, data, opts.mode !== undefined ? { encoding: "utf8", mode: opts.mode } : "utf8");
    } else {
      await fs.writeFile(tmp, data, opts.mode !== undefined ? { mode: opts.mode } : undefined);
    }
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}
