/**
 * 拉取写本地文件时的路径检查与写入：只在仓库根之内、路径上没有软链接时才写；
 * 从不删除文件，只在确认上一级不是软链接之后才逐级建目录；写入一律原子写（临时文件放在
 * 目标所在目录，再 rename）。kh pull 与 kh conflicts resolve --take-remote 共用。
 */
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../fs-utils";

export type LocalEntry =
  | { kind: "absent" }
  | { kind: "file"; absPath: string; size: number; mtimeMs: number; mode: number }
  | { kind: "unsafe"; reason: string };

/** 写入前的复查没通过：路径变得不安全，或者文件在检查之后被改动过。调用方跳过这个文件，不写任何东西 */
export class LocalChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalChangedError";
  }
}

async function lstatOrNull(p: string): Promise<Stats | null> {
  try {
    return await fs.lstat(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw err;
  }
}

function unsafe(reason: string): LocalEntry {
  return { kind: "unsafe", reason };
}

/** 把仓库内的 POSIX 相对路径拆成段；出现空段、. 或 .. 时返回 null（这种路径一律不写） */
function splitRepoPath(relPath: string): string[] | null {
  const segs = relPath.split("/");
  if (segs.some((seg) => seg === "" || seg === "." || seg === "..")) return null;
  return segs;
}

function normalizeForCompare(p: string): string {
  return p.normalize("NFC").toLowerCase();
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * 看本地这个路径现在是什么：不存在（包括父目录也不存在）、普通文件，或者不安全——
 * 自身或某一级父目录是软链接、某一级父路径不是目录、本地同名路径是目录或其他特殊文件。
 * 只做 lstat，不跟随任何软链接。
 */
export async function inspectLocalPath(root: string, relPath: string): Promise<LocalEntry> {
  const segs = splitRepoPath(relPath);
  if (segs === null) return unsafe("路径写法不合法");

  let current = root;
  for (const seg of segs.slice(0, -1)) {
    current = path.join(current, seg);
    const st = await lstatOrNull(current);
    if (st === null) return { kind: "absent" };
    if (st.isSymbolicLink()) return unsafe("某一级父目录是软链接");
    if (!st.isDirectory()) return unsafe("某一级父路径不是目录");
  }

  const absPath = path.join(current, segs[segs.length - 1]!);
  if (!isInside(root, absPath)) return unsafe("路径不在仓库内");
  const st = await lstatOrNull(absPath);
  if (st === null) return { kind: "absent" };
  if (st.isSymbolicLink()) return unsafe("本地路径是软链接");
  if (st.isDirectory()) return unsafe("本地同名路径是目录");
  if (!st.isFile()) return unsafe("本地路径不是普通文件");
  return { kind: "file", absPath, size: st.size, mtimeMs: st.mtimeMs, mode: st.mode };
}

export interface WrittenFile {
  absPath: string;
  size: number;
  mtimeMs: number;
}

/**
 * 把内容原子写到仓库里的 relPath。写之前按 expected 复查：
 * - 逐级检查父目录：存在的必须是真实目录（不是软链接）；不存在的在确认上一级安全之后逐个新建，
 *   建完再 lstat 确认；
 * - 父目录解析后的真实路径必须仍在仓库根之内；
 * - expected 为 absent 时目标必须仍不存在；为 file 时必须仍是同样 size、mtime 的普通文件
 *   （中途被人改过就不覆盖），覆盖时保留原来的权限位。
 * 任何一项不满足都抛 LocalChangedError，不写入。
 */
export async function writeLocalFile(
  root: string,
  relPath: string,
  bytes: Uint8Array,
  expected: Exclude<LocalEntry, { kind: "unsafe" }>,
): Promise<WrittenFile> {
  const segs = splitRepoPath(relPath);
  if (segs === null) throw new LocalChangedError(`路径写法不合法：${relPath}`);

  let current = root;
  for (const seg of segs.slice(0, -1)) {
    current = path.join(current, seg);
    let st = await lstatOrNull(current);
    if (st === null) {
      try {
        await fs.mkdir(current);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      st = await lstatOrNull(current);
    }
    if (st === null || st.isSymbolicLink() || !st.isDirectory()) {
      throw new LocalChangedError(`路径上有软链接或非目录，不写入：${relPath}`);
    }
  }

  // 父目录解析后的真实路径必须恰好是“仓库根的真实路径 + 各级父目录段”：不只要求在仓库内，
  // 这样中途任何一级被换成指向仓库内别处的软链接也能发现。大小写不敏感的文件系统上 realpath
  // 可能返回磁盘上的实际大小写，所以按规范化（NFC、小写）后比较
  const [realRoot, realParent] = await Promise.all([fs.realpath(root), fs.realpath(current)]);
  const expectedParent = path.join(realRoot, ...segs.slice(0, -1));
  if (normalizeForCompare(realParent) !== normalizeForCompare(expectedParent)) {
    throw new LocalChangedError(`目标父目录解析后的位置不对，不写入：${relPath}`);
  }

  // 这里的复查与下面的 rename 之间仍有一个很短的窗口：期间如果有别的进程在目标位置新建或改动
  // 文件，rename 会整体替换掉它（rename 不跟随目标位置的软链接，只替换链接本身，不会写到仓库外）。
  // 这个窗口无法在不加文件锁的前提下完全消除；复查把它收窄到一次 lstat 加一次原子写的时间
  const absPath = path.join(current, segs[segs.length - 1]!);
  const st = await lstatOrNull(absPath);
  let mode: number | undefined;
  if (expected.kind === "absent") {
    if (st !== null) throw new LocalChangedError(`本地文件在拉取过程中出现了，不覆盖：${relPath}`);
  } else {
    const unchanged =
      st !== null && st.isFile() && !st.isSymbolicLink() && st.size === expected.size && st.mtimeMs === expected.mtimeMs;
    if (!unchanged) throw new LocalChangedError(`本地文件在拉取过程中被改动，不覆盖：${relPath}`);
    mode = st.mode & 0o7777;
  }

  await writeFileAtomic(absPath, bytes, mode !== undefined ? { mode } : {});
  const after = await fs.lstat(absPath);
  return { absPath, size: after.size, mtimeMs: after.mtimeMs };
}
