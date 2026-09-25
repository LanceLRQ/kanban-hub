import fs from "node:fs/promises";
import path from "node:path";
import { CliError, EXIT } from "../errors";
import { isNoEntError } from "./fs-utils";

/** 按顺序检查，存在的目录建议为 <目录>/** */
const SUGGESTED_DOC_DIRS = ["docs", "doc", "design"] as const;

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch (err) {
    if (isNoEntError(err)) return false;
    throw err;
  }
}

async function hasRootMarkdown(root: string): Promise<boolean> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if (isNoEntError(err)) return false;
    throw err;
  }
  return entries.some((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"));
}

/**
 * 建议的同步范围：docs/、doc/、design/ 依次检查，存在的目录建议为 <目录>/**；仓库根目录下有
 * .md 文件时（CLAUDE.local.md 也算），最后再加 *.md。--include 会完全代替这里的建议，由调用方决定。
 */
export async function suggestSyncInclude(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const dir of SUGGESTED_DOC_DIRS) {
    if (await isDirectory(path.join(root, dir))) result.push(`${dir}/**`);
  }
  if (await hasRootMarkdown(root)) result.push("*.md");
  return result;
}

/**
 * 校验同步范围的 glob 写法：不能为空、必须是 POSIX 形式、不能以 / 开头、不能含 .. 段。
 * glob 本身的匹配语义在 M5 实现，这里只管写法。
 */
export function validateSyncGlob(glob: string): void {
  if (glob === "") {
    throw new CliError(EXIT.USAGE, "同步范围不能是空字符串");
  }
  if (glob.includes("\\")) {
    throw new CliError(EXIT.USAGE, `同步范围必须是 POSIX 形式（不能包含 \\）：${glob}`);
  }
  if (glob.startsWith("/")) {
    throw new CliError(EXIT.USAGE, `同步范围不能以 / 开头：${glob}`, "写成仓库内的相对路径，例如 docs/**");
  }
  if (glob.split("/").includes("..")) {
    throw new CliError(EXIT.USAGE, `同步范围不能包含 ..：${glob}`);
  }
}
