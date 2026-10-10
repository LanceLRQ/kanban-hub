import path from "node:path";
import type { SyncScope } from "@kanban-hub/core/schema";
import type { CliContext } from "../context";
import { formatByteSize, REPO_CONFIG_DIR, REPO_IGNORE_FILE, toSyncScope } from "../repo/config";
import type { RegisteredRepo } from "../repo/root";
import { readIgnoreLines, type SkippedDir } from "./ignore";
import { assertValidScope } from "./push";
import { scanSyncFiles, type ScanResult } from "./scan";

/** 建议同步的扩展名（小写、不带点）：文档、网页、图片、图表源，另含 yaml */
export const SUGGESTED_EXTENSIONS: ReadonlySet<string> = new Set([
  "md", "mdx", "txt", "pdf", "rst", "adoc", "csv",
  "html", "htm", "css", "js", "mjs", "json", "svg", "woff", "woff2", "ttf", "otf",
  "png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "bmp",
  "mmd", "puml", "drawio", "excalidraw",
  "yaml", "yml",
]);

const ROOT_LABEL = "（根目录）";
const NO_EXT_LABEL = "（无扩展名）";
const IGNORE_FILE_LABEL = `${REPO_CONFIG_DIR}/${REPO_IGNORE_FILE}`;

/** 任意字节数的易读写法：保留一位小数；push 摘要里的 formatByteSize 只处理整除的情况 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** 汇总用的目录：docs/a/b/c.md 归到 docs/a/，docs/x.md 归到 docs/，根下的文件归到（根目录） */
function groupOf(filePath: string): string {
  const segs = filePath.split("/");
  if (segs.length === 1) return ROOT_LABEL;
  return `${segs.slice(0, Math.min(2, segs.length - 1)).join("/")}/`;
}

function extensionOf(filePath: string): string {
  const ext = path.posix.extname(filePath).slice(1).toLowerCase();
  return ext === "" ? NO_EXT_LABEL : ext;
}

function describeSkippedDir(dir: SkippedDir): string {
  if (dir.category === "builtin") return `内置规则 ${dir.reason}`;
  if (dir.category === "ignoreFile") return `${IGNORE_FILE_LABEL} 规则 ${dir.reason}`;
  return dir.reason;
}

function summarizeGroups(files: ScanResult["files"]): string[] {
  const groups = new Map<string, { count: number; size: number }>();
  for (const f of files) {
    const key = groupOf(f.path);
    const entry = groups.get(key) ?? { count: 0, size: 0 };
    entry.count += 1;
    entry.size += f.size;
    groups.set(key, entry);
  }
  const keys = [...groups.keys()].sort((a, b) => {
    if (a === ROOT_LABEL) return b === ROOT_LABEL ? 0 : -1;
    if (b === ROOT_LABEL) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return keys.map((key) => `  ${key}  ${groups.get(key)!.count} 个文件  ${formatSize(groups.get(key)!.size)}`);
}

function summarizeExtensions(files: ScanResult["files"]): string[] {
  const exts = new Map<string, { count: number; example: string }>();
  for (const f of files) {
    const ext = extensionOf(f.path);
    if (SUGGESTED_EXTENSIONS.has(ext)) continue;
    const entry = exts.get(ext);
    if (entry) entry.count += 1;
    else exts.set(ext, { count: 1, example: f.path });
  }
  return [...exts.entries()]
    .sort(([a, x], [b, y]) => y.count - x.count || (a < b ? -1 : a > b ? 1 : 0))
    .map(([ext, { count, example }]) => `  ${ext === NO_EXT_LABEL ? ext : `.${ext}`}  ${count} 个，例如 ${example}`);
}

/** 把一次本机扫描的结果渲染成 kh sync --dry-run 的输出 */
export function renderSyncPlan(scan: ScanResult, scope: SyncScope): string {
  const totalSize = scan.files.reduce((sum, f) => sum + f.size, 0);
  const lines: string[] = [`将同步 ${scan.files.length} 个文件，共 ${formatSize(totalSize)}`];

  if (scan.files.length > 0) {
    lines.push("按目录汇总：", ...summarizeGroups(scan.files));
  }

  if (scan.skippedDirs.length > 0) {
    lines.push("被跳过的目录：");
    for (const dir of scan.skippedDirs) lines.push(`  ${dir.path}  ${describeSkippedDir(dir)}`);
    lines.push(`要上传其中某个目录，在 ${IGNORE_FILE_LABEL} 里写一行 \`!<目录>/\``);
  }

  if (scan.skipped.length > 0) {
    lines.push(`超过大小上限（${formatByteSize(scope.maxFileSize)}），已跳过：`);
    for (const item of scan.skipped) lines.push(`  ${item.path}（${formatByteSize(item.size)}）`);
  }

  const extLines = summarizeExtensions(scan.files);
  if (extLines.length > 0) {
    lines.push("文件类型建议：", ...extLines);
    lines.push(`建议只同步文档、网页和图片；不需要的加进 ${IGNORE_FILE_LABEL}`);
  }

  return `${lines.join("\n")}\n`;
}

/**
 * kh sync --dry-run：只在本机扫描并打印将要同步的内容。不联网、不要求登录，
 * 也不打开本机同步状态，因此不会改动任何东西。
 */
export async function runSyncDryRun(ctx: CliContext, repo: RegisteredRepo): Promise<void> {
  assertValidScope(repo.config);
  const scope = toSyncScope(repo.config);
  const scan = await scanSyncFiles(repo.root, scope, await readIgnoreLines(repo.root));
  ctx.stdout.write(renderSyncPlan(scan, scope));
}
