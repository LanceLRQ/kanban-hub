/**
 * 备份的打包与恢复（规格 6.6）：把数据目录全量打包成 zip（可选 AES-256 加密），把备份 zip
 * 恢复到空目录。两个入口都是不依赖 Store 的纯函数；Store.createBackup 负责先提交一次再打包。
 *
 * zip 的内部结构：根下一个 manifest.json（格式、版本、创建时间、是否含 git 历史），其余内容
 * 全部在 data/ 前缀下，恢复时按 data/ 里的相对路径写回目标目录。
 * 加密用 WinZip AE（AES-256），外部工具（7-Zip 等）也能用密码解开。
 */
import fs from "node:fs/promises";
import { readdirSync, statSync, type Dirent } from "node:fs";
import path from "node:path";
import { KhError } from "@kanban-hub/core/errors";
import { KH_VERSION } from "@kanban-hub/core/version";
import {
  ERR_INVALID_AUTHENTICATION_CODE,
  ERR_INVALID_PASSWORD,
  Reader,
  TextReader,
  TextWriter,
  Uint8ArrayReader,
  ZipReader,
  ZipWriter,
  type Entry,
  type FileEntry,
} from "@zip.js/zip.js";

export const BACKUP_FORMAT = "kanban-hub-backup";
export const BACKUP_FORMAT_VERSION = 1;
/**
 * 备份文件名：kanban-hub-YYYYMMDD-HHmmss.zip（本机时区），同秒冲突时在 .zip 前依次加 -1、-2。
 * 备份的下载与读取接口用它校验文件名参数，挡住路径穿越。
 */
export const BACKUP_FILE_NAME_RE = /^kanban-hub-\d{8}-\d{6}(-\d+)?\.zip$/;
/** 恢复的暂存目录名：先解压到目标目录内的这里，全部成功后再移到目录根 */
const RESTORE_TMP_DIR = ".restore-tmp";

const MANIFEST_NAME = "manifest.json";
const DATA_PREFIX = "data/";

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_FORMAT_VERSION;
  createdAt: string;
  includeGit: boolean;
  khVersion: string;
}

/** 一份备份的展示信息：列表与创建接口共用 */
export interface BackupFileInfo {
  fileName: string;
  size: number;
  createdAt: string;
}

export interface CreateBackupOptions {
  /** 不传或空串 = 不加密 */
  password?: string;
  /** 是否打包数据目录的 .git 历史，默认包含 */
  includeGit?: boolean;
  now?: () => Date;
}

/**
 * 打包数据目录（规格 6.6）：内容是数据目录全量（includeGit 为假时只排除数据目录自己的 .git）。
 * 先写 `<最终文件名>.tmp-<pid>`，成功后改名；同秒同名时依次加 -1、-2 后缀。
 * 失败时把临时文件和已改名的产物都删掉，备份目录里不留残余。
 */
export async function writeBackupArchive(
  dataDir: string,
  backupDir: string,
  opts: CreateBackupOptions = {},
): Promise<BackupFileInfo> {
  const includeGit = opts.includeGit ?? true;
  // 密码空串视同未传：网页表单留空时提交上来的就是空字符串
  const password = opts.password ? opts.password : undefined;
  const at = (opts.now ?? (() => new Date()))();
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_FORMAT_VERSION,
    createdAt: at.toISOString(),
    includeGit,
    khVersion: KH_VERSION,
  };
  await fs.mkdir(backupDir, { recursive: true });
  const finalPath = await resolveBackupPath(backupDir, backupBaseName(at));
  const tmpPath = `${finalPath}.tmp-${process.pid}`;
  try {
    await writeArchive(dataDir, tmpPath, manifest, password);
    await fs.rename(tmpPath, finalPath);
    return { fileName: path.basename(finalPath), size: (await fs.stat(finalPath)).size, createdAt: manifest.createdAt };
  } catch (e) {
    // 改名之后失败的产物也删：调用方不该看到一份不知是否完整的备份
    await removeQuietly(tmpPath);
    await removeQuietly(finalPath);
    throw e;
  }
}

/**
 * 把备份 zip 恢复到目标数据目录（规格 6.6：只允许恢复到空目录）。不依赖 Store，供独立恢复入口使用。
 * 目标目录必须为空或不存在；entry 名只能是 manifest.json 或 data/ 前缀下的相对路径，
 * 含 .. 段的一律拒绝；manifest 的格式或版本不认识时拒绝；密码错误转成中文错误信息。
 * 落盘分两段：先解压到目标目录内的 .restore-tmp/，全部成功后再移到目录根；
 * 中途失败删除暂存，目标目录保持原样，可以重试。
 */
export async function restoreArchive(
  backupFile: string,
  dataDir: string,
  opts: { password?: string } = {},
): Promise<{ files: number; manifest: BackupManifest }> {
  await assertEmptyTarget(dataDir);
  const password = opts.password ? opts.password : undefined;
  const handle = await openBackupFile(backupFile);
  try {
    const entries = await readEntries(handle, password);
    assertSafeEntryNames(entries);
    // manifest 也是加密的：密码错误在这一步就暴露，不用等解压
    const manifest = await readManifest(entries);

    const tmpRoot = path.join(dataDir, RESTORE_TMP_DIR);
    try {
      const files = await extractEntries(entries, tmpRoot);
      await moveRestored(tmpRoot, dataDir);
      await fs.rm(tmpRoot, { recursive: true, force: true });
      return { files, manifest };
    } catch (e) {
      // 恢复失败不留暂存：目标目录回到空的状态，处理过原因之后可以重试
      await removeQuietly(tmpRoot);
      throw e;
    }
  } finally {
    await handle.close();
  }
}

/** 列出备份目录里的备份文件（只认文件名匹配约定正则的），按创建时间倒序 */
export function listBackupFiles(backupDir: string): BackupFileInfo[] {
  let names: string[];
  try {
    names = readdirSync(backupDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const list: BackupFileInfo[] = [];
  for (const name of names) {
    if (!BACKUP_FILE_NAME_RE.test(name)) continue;
    const st = statSync(path.join(backupDir, name), { throwIfNoEntry: false });
    if (!st?.isFile()) continue;
    list.push({ fileName: name, size: st.size, createdAt: st.mtime.toISOString() });
  }
  // ISO 字符串的字典序就是时间序，保险起见还是按时间戳比
  return list.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

// ---------- 打包 ----------

/** 基于 Node FileHandle 的随机读取：zip.js 按字节区间读中央目录和条目，文件不用整个进内存 */
class FileRangeReader extends Reader<fs.FileHandle> {
  constructor(private readonly file: fs.FileHandle) {
    super(file);
  }

  override async init(): Promise<void> {
    await super.init?.();
    this.size = (await this.file.stat()).size;
  }

  override async readUint8Array(index: number, length: number): Promise<Uint8Array> {
    const buffer = new Uint8Array(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await this.file.read(buffer, read, length - read, index + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return buffer.subarray(0, read);
  }
}

/**
 * 打包到临时文件。zip.js 的 Node 环境必须关掉 Web Worker；加密用 WinZip AE 的最高档
 * AES-256（encryptionStrength: 3）。密码只在 ZipWriter 选项里出现，不进日志和错误信息。
 */
async function writeArchive(dataDir: string, tmpPath: string, manifest: BackupManifest, password?: string): Promise<void> {
  const handle = await fs.open(tmpPath, "w");
  // ZipWriter.close() 会关掉底下的流；中途失败时在这里兜底关句柄
  let closed = false;
  const closeHandle = async () => {
    if (!closed) {
      closed = true;
      await handle.close();
    }
  };
  try {
    const zip = new ZipWriter(
      {
        writable: new WritableStream({
          async write(chunk) {
            await handle.write(chunk);
          },
          async close() {
            await closeHandle();
          },
          async abort() {
            await closeHandle();
          },
        }),
      },
      { password, encryptionStrength: 3, useWebWorkers: false },
    );
    await zip.add(MANIFEST_NAME, new TextReader(JSON.stringify(manifest, null, 2)));
    // 逐个读进内存再压缩：个人规模的数据目录很小，没必要为此引入流式读取的复杂度
    for (const rel of (await listDataFiles(dataDir, manifest.includeGit)).sort()) {
      const bytes = await fs.readFile(path.join(dataDir, ...rel.split("/")));
      await zip.add(DATA_PREFIX + rel, new Uint8ArrayReader(bytes));
    }
    await zip.close();
  } catch (e) {
    await closeHandle();
    throw e;
  }
}

/** 数据目录里的全部文件，POSIX 相对路径；includeGit 为假时只排除数据目录自己的 .git */
async function listDataFiles(dataDir: string, includeGit: boolean, rel = ""): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(path.join(dataDir, rel), { withFileTypes: true });
  } catch (e) {
    // 根目录不存在是调用方的错误，原样抛出；子目录不会缺（写操作先建目录再写文件）
    if (rel !== "" && (e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: string[] = [];
  for (const entry of entries) {
    const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      // 快照里可能带着被同步仓库自己的 .git，只有数据目录根上的这个是本程序的历史
      if (!includeGit && childRel === ".git") continue;
      out.push(...(await listDataFiles(dataDir, includeGit, childRel)));
    } else if (entry.isFile()) {
      out.push(childRel);
    }
  }
  return out;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** 文件名里的时间用本机时区（与规格的产物示例一致） */
function backupBaseName(at: Date): string {
  return `kanban-hub-${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}.zip`;
}

/** 同名（同秒再打一份）时依次加 -1、-2，直到名字空出来 */
async function resolveBackupPath(backupDir: string, baseName: string): Promise<string> {
  const stem = baseName.slice(0, -".zip".length);
  for (let n = 0; ; n += 1) {
    const candidate = n === 0 ? baseName : `${stem}-${n}.zip`;
    const target = path.join(backupDir, candidate);
    try {
      await fs.stat(target);
    } catch {
      return target;
    }
  }
}

/** 尽力清理：目录已经不可写等场景下，清理失败不掩盖原始错误 */
async function removeQuietly(target: string): Promise<void> {
  try {
    await fs.rm(target, { recursive: true, force: true });
  } catch {
    // 清理失败时以原始错误为准
  }
}

// ---------- 恢复 ----------

async function openBackupFile(backupFile: string): Promise<fs.FileHandle> {
  try {
    return await fs.open(backupFile, "r");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new KhError("not_found", `备份文件不存在：${path.basename(backupFile)}`);
    }
    throw e;
  }
}

async function readEntries(handle: fs.FileHandle, password?: string): Promise<Entry[]> {
  const reader = new ZipReader(new FileRangeReader(handle), { password });
  try {
    return await reader.getEntries();
  } catch (e) {
    throw mapZipError(e);
  } finally {
    await reader.close();
  }
}

/**
 * 恢复前校验每个 entry 名（补充安全防线）：只能是 manifest.json，或 data/ 前缀下的相对路径，
 * 不得含 .. 段；中间有空段的、非结尾斜杠造成的空段也当坏名字拒绝。
 */
function assertSafeEntryNames(entries: readonly Entry[]): void {
  for (const entry of entries) {
    const name = entry.filename;
    if (name === MANIFEST_NAME) continue;
    if (!name.startsWith(DATA_PREFIX) || name === DATA_PREFIX) {
      throw new KhError("invalid", `备份里有数据目录之外的条目（${name}），拒绝恢复`);
    }
    const segments = name.slice(DATA_PREFIX.length).replace(/\/$/, "").split("/");
    if (segments.some((s) => s === "..")) {
      throw new KhError("invalid", `备份里有越出数据目录的条目（${name}），拒绝恢复`);
    }
    if (segments.some((s) => s === "")) {
      throw new KhError("invalid", `备份里有不合法的条目名（${name}），拒绝恢复`);
    }
  }
}

/** 读出并校验 manifest：格式或版本不认识的备份一律拒绝（向前兼容时在这里放行更新的版本） */
async function readManifest(entries: readonly Entry[]): Promise<BackupManifest> {
  const entry = entries.find((e) => e.filename === MANIFEST_NAME);
  if (!entry || entry.directory) {
    throw new KhError("invalid", "备份缺少 manifest.json，不是本程序的备份文件");
  }
  let text: string;
  try {
    text = await (entry as FileEntry).getData(new TextWriter());
  } catch (e) {
    throw mapZipError(e);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new KhError("invalid", "备份的 manifest.json 不是合法的 JSON");
  }
  const m = parsed as BackupManifest | null;
  if (!m || m.format !== BACKUP_FORMAT) {
    throw new KhError("invalid", "备份格式不认识，无法在这个版本上恢复");
  }
  if (typeof m.version !== "number" || m.version < BACKUP_FORMAT_VERSION || m.version > BACKUP_FORMAT_VERSION) {
    throw new KhError("invalid", `备份格式版本不支持（${String(m.version)}），当前支持版本 ${BACKUP_FORMAT_VERSION}`);
  }
  return m;
}

/** 把 data/ 前缀下的文件条目解压到暂存目录，返回文件数（manifest 不算，目录条目不落盘） */
async function extractEntries(entries: readonly Entry[], tmpRoot: string): Promise<number> {
  let count = 0;
  for (const entry of entries) {
    if (entry.directory || entry.filename === MANIFEST_NAME) continue;
    const target = path.join(tmpRoot, ...entry.filename.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    const file = await fs.open(target, "w");
    try {
      await (entry as FileEntry).getData(
        new WritableStream({
          async write(chunk) {
            await file.write(chunk);
          },
        }),
      );
    } finally {
      await file.close();
    }
    count += 1;
  }
  return count;
}

/** 两段式的第二段：把暂存里 data/ 下的内容移到目标目录根；manifest 只是元数据，不进数据目录 */
async function moveRestored(tmpRoot: string, dataDir: string): Promise<void> {
  const staged = path.join(tmpRoot, "data");
  let names: string[];
  try {
    names = await fs.readdir(staged);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  for (const name of names) {
    await fs.rename(path.join(staged, name), path.join(dataDir, name));
  }
}

/** 目标目录必须是空的或还不存在（规格 6.6），否则以 conflict 拒绝，什么都不写 */
async function assertEmptyTarget(dataDir: string): Promise<void> {
  let existing: string[];
  try {
    existing = await fs.readdir(dataDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  if (existing.length > 0) {
    throw new KhError("conflict", "目标数据目录不是空的，只能恢复到空目录");
  }
}

/**
 * zip.js 的错误转成中文业务错误。密码错误和解密校验失败是同一个入口（解密是在读内容时发生的），
 * 统一说“密码错误或文件已损坏”；zip.js 的错误信息只有错误码，不会带密码。
 */
function mapZipError(e: unknown): KhError {
  const message = e instanceof Error ? e.message : String(e);
  if (message.includes(ERR_INVALID_PASSWORD) || message.includes(ERR_INVALID_AUTHENTICATION_CODE)) {
    return new KhError("invalid", "备份解密失败：密码错误，或备份文件已损坏");
  }
  return new KhError("invalid", `备份文件读不出来：${message}`);
}
