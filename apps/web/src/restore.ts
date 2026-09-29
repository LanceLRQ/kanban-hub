/**
 * 独立的恢复入口（esbuild 打包成 dist/restore.mjs）：把备份 zip 恢复到数据目录，
 * 供容器里 `docker compose run --rm kanban-hub restore <文件>` 或本机 node 直接运行。
 * 恢复逻辑全部复用 server/store/backup 的 restoreArchive（空目录校验、条目名校验、
 * manifest 校验、密码错误转中文），这里只做参数解析、密码来源、确认交互与退出码。
 *
 * 退出码：0 成功（含 --help）；2 用法错误；1 恢复失败或用户取消。
 * 密码纪律：--password 的值只进 ZipWriter/ZipReader 选项，不回显、不进错误信息与日志。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { Uint8ArrayReader, TextWriter, ZipReader, ERR_INVALID_AUTHENTICATION_CODE, ERR_INVALID_PASSWORD, type Entry } from "@zip.js/zip.js";
import { KhError, isKhError } from "@kanban-hub/core/errors";
import { restoreArchive, type BackupManifest } from "./server/store/backup";

const DEFAULT_DATA_DIR = "/data";
const MANIFEST_NAME = "manifest.json";

const USAGE = `用法：node restore.mjs <备份文件> [选项]

把 kanban-hub 的备份 zip 恢复到数据目录（只能恢复到空目录，恢复前目录里的内容不会被动到）。

选项：
  --data-dir <目录>  目标数据目录（默认取环境变量 KH_DATA_DIR，再默认 ${DEFAULT_DATA_DIR}）
  --password <密码>  备份密码（默认取环境变量 KH_RESTORE_PASSWORD；都没有且在终端运行时交互输入，直接回车表示备份未加密）。
                     注意：命令行传入的密码会留在 shell 历史里，脚本场景建议改用 KH_RESTORE_PASSWORD
  --yes              跳过确认，直接恢复
  -h, --help         显示本帮助

退出码：0 成功；2 用法错误；1 恢复失败或已取消`;

/** 用法错误：进程以退出码 2 结束，信息面向使用者 */
export class UsageError extends Error {}

/** 在隐藏输入里按了 Ctrl-C / Ctrl-D：用户放弃输入，进程按取消退出 */
class InputCancelled extends Error {}

export interface CliIo {
  stdin: Readable & { isTTY?: boolean };
  stdout: Writable;
  stderr: Writable;
  env: Record<string, string | undefined>;
}

export const defaultIo: CliIo = {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
};

interface ParsedArgs {
  backupFile: string;
  dataDir?: string;
  password?: string;
  yes: boolean;
  help: boolean;
}

/** 带值的选项；其余 -- 开头的都是无值开关 */
const OPTIONS_WITH_VALUE = new Set(["--data-dir", "--password"]);

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { backupFile: "", yes: false, help: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      parsed.help = true;
      continue;
    }
    if (arg === "--yes") {
      parsed.yes = true;
      continue;
    }
    // --选项 值 与 --选项=值 两种写法都收
    let name = arg;
    let value: string | undefined;
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq > 0) {
      name = arg.slice(0, eq);
      value = arg.slice(eq + 1);
    }
    if (OPTIONS_WITH_VALUE.has(name)) {
      if (value === undefined) {
        const next = argv[i + 1];
        if (next === undefined) throw new UsageError(`选项 ${name} 缺少参数值`);
        value = next;
        i += 1;
      }
      if (name === "--data-dir") parsed.dataDir = value;
      else parsed.password = value;
      continue;
    }
    if (arg.startsWith("--")) throw new UsageError(`未知选项：${name}`);
    positional.push(arg);
  }
  if (!parsed.help) {
    if (positional.length === 0) throw new UsageError("缺少备份文件参数");
    if (positional.length > 1) throw new UsageError(`参数过多：一次只能恢复一份备份（多余：${positional.slice(1).join(" ")}）`);
    parsed.backupFile = positional[0]!;
  }
  return parsed;
}

export async function main(argv: string[], io: CliIo = defaultIo): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr.write(`用法错误：${e.message}\n\n${USAGE}\n`);
      return 2;
    }
    throw e;
  }
  if (parsed.help) {
    io.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const dataDir = parsed.dataDir ?? io.env.KH_DATA_DIR ?? DEFAULT_DATA_DIR;
  let password: string | undefined;
  try {
    password = await resolvePassword(parsed, io);
  } catch (e) {
    // 输入密码途中按了 Ctrl-C / Ctrl-D：什么都不做，按用户取消退出
    if (e instanceof InputCancelled) {
      io.stderr.write("已取消，未做任何改动\n");
      return 1;
    }
    throw e;
  }

  // 先读 manifest 打摘要，让用户在确认之前知道这份备份是什么时候、从哪个版本打出来的。
  // 摘要读不出来（不是本程序的备份、密码不对）就不往下走，避免让人对着不明文件确认。
  let manifest: BackupManifest;
  try {
    manifest = await readManifestSummary(parsed.backupFile, password);
  } catch (e) {
    io.stderr.write(`${errorText(e)}\n`);
    return 1;
  }
  io.stdout.write(
    [
      `备份文件：${parsed.backupFile}`,
      `  创建时间：${manifest.createdAt}`,
      `  含 git 历史：${manifest.includeGit ? "是" : "否"}`,
      `  备份时版本：${manifest.khVersion}`,
      `目标数据目录：${dataDir}（只能恢复到空目录）`,
      "",
    ].join("\n"),
  );

  if (!parsed.yes) {
    const refusal = await requireInteractiveConfirm(io);
    if (refusal !== null) {
      io.stderr.write(`${refusal.message}\n`);
      // 用法档的拒绝（如非终端没加 --yes）把用法一并给出，帮助当场纠正
      if (refusal.exitCode === 2) io.stderr.write(`\n${USAGE}\n`);
      return refusal.exitCode;
    }
  }

  try {
    const { files, manifest: restored } = await restoreArchive(parsed.backupFile, dataDir, { password });
    io.stdout.write(`恢复完成：写入 ${files} 个文件，${restored.includeGit ? "包含" : "不包含"} git 历史。\n`);
    return 0;
  } catch (e) {
    io.stderr.write(`${errorText(e)}\n`);
    return 1;
  }
}

/**
 * 密码来源优先级：--password > KH_RESTORE_PASSWORD > 终端交互（非终端不问，留给解密错误兜底）。
 * 交互放在读摘要之前：manifest 本身也加密，不给密码连摘要都读不出来，没法先判断要不要密码。
 */
async function resolvePassword(parsed: ParsedArgs, io: CliIo): Promise<string | undefined> {
  if (parsed.password) return parsed.password;
  const fromEnv = io.env.KH_RESTORE_PASSWORD;
  if (fromEnv) return fromEnv;
  if (io.stdin.isTTY) return promptPassword(io);
  return undefined;
}

/** 确认没通过时的结果：给用户的信息与对应的退出码 */
interface Refusal {
  message: string;
  exitCode: number;
}

/** 非 TTY 不能交互：没有 --yes 就拒绝执行，避免脚本里挂死等人输入 */
async function requireInteractiveConfirm(io: CliIo): Promise<Refusal | null> {
  if (!io.stdin.isTTY) {
    return { message: "标准输入不是终端且未加 --yes：拒绝执行。脚本等非交互场景请加 --yes", exitCode: 2 };
  }
  io.stderr.write("输入 y 确认恢复，其他输入取消：");
  const answer = (await readLine(io.stdin)).trim().toLowerCase();
  if (answer === "y" || answer === "yes" || answer === "是") return null;
  return { message: "已取消，未做任何改动", exitCode: 1 };
}

/**
 * 等到一段可读字节（push 模式 read()）。不用 data 事件：它会把流拉进流动模式，
 * 一次读不完的剩余字节容易在两次读取之间丢；readable/read 模式下缓冲一直在，读多少取多少。
 * 返回 null 表示输入结束。
 */
function readChunk(input: Readable): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const chunk = input.read();
      if (chunk !== null) {
        cleanup();
        resolve(chunk);
      }
      // null：缓冲里还没有数据，等下一次 readable / end
    };
    const onEnd = () => {
      cleanup();
      resolve(null);
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      input.off("readable", attempt);
      input.off("end", onEnd);
      input.off("error", onError);
    };
    input.on("readable", attempt);
    input.once("end", onEnd);
    input.once("error", onError);
    // 监听之前缓冲里可能已经有数据，此时不会再触发 readable
    attempt();
  });
}

/** 从输入流读一行（到 \n 为止，去掉结尾的 \r）。一次读不完的字节退回流里，不影响下一个读取者 */
async function readLine(input: Readable): Promise<string> {
  // StringDecoder 扣住跨块的半截多字节字符，粘贴含中文等字符的输入不会被块边界切碎
  const decoder = new StringDecoder("utf8");
  let text = "";
  for (;;) {
    const chunk = await readChunk(input);
    if (chunk === null) {
      text += decoder.end();
      return text;
    }
    text += decoder.write(chunk);
    const nl = text.indexOf("\n");
    if (nl >= 0) {
      pushBack(input, text.slice(nl + 1));
      return text.slice(0, nl).replace(/\r$/, "");
    }
  }
}

/** 不回显地读一行密码。可空：直接回车表示备份未加密 */
async function promptPassword(io: CliIo): Promise<string | undefined> {
  io.stderr.write("备份密码（直接回车表示备份未加密）：");
  const line = await readHiddenLine(io.stdin);
  io.stderr.write("\n");
  return line.length > 0 ? line : undefined;
}

/** 没消费完的字节退回流缓冲，push 模式下读多少算多少，剩下的留给下一个读取者 */
function pushBack(input: Readable, text: string): void {
  if (text.length > 0) input.unshift(Buffer.from(text, "utf8"));
}

/**
 * 读一行不显示输入。终端用 raw 模式逐字收：终端驱动不再回显，退格就地删字；
 * 管道（测试、脚本）按块读，只消费到行尾为止，多读的字节退回流里给下一个读取者。
 */
async function readHiddenLine(input: Readable & { isTTY?: boolean; setRawMode?: (mode: boolean) => void }): Promise<string> {
  const raw = input.isTTY === true && typeof input.setRawMode === "function";
  if (raw) input.setRawMode!(true);
  // StringDecoder 扣住跨块的半截多字节字符，粘贴含中文等字符的密码不会被块边界切碎
  const decoder = new StringDecoder("utf8");
  try {
    let line = "";
    for (;;) {
      const chunk = await readChunk(input);
      if (chunk === null) {
        line += decoder.end();
        return line;
      }
      const data = decoder.write(chunk);
      for (let i = 0; i < data.length; i += 1) {
        const ch = data[i]!;
        // raw 模式下 ISIG 关闭，Ctrl-C / Ctrl-D 只是普通字节，不会产生 SIGINT；
        // 这里识别成放弃输入抛出去（finally 恢复终端），不然用户只能干等
        if (ch === "\u0003" || ch === "\u0004") throw new InputCancelled();
        // DEL / Ctrl-H：删掉上一个字符（raw 模式下终端不处理编辑键）
        if (ch === "\u007f" || ch === "\b") {
          line = line.slice(0, -1);
          continue;
        }
        if (ch === "\n" || ch === "\r") {
          // \r\n 是一次回车：把紧跟的 \n 一起消费掉，别留给下一次读取
          let rest = data.slice(i + 1);
          if (ch === "\r" && rest.startsWith("\n")) rest = rest.slice(1);
          pushBack(input, rest);
          return line;
        }
        line += ch;
      }
    }
  } finally {
    if (raw) input.setRawMode!(false);
  }
}

/**
 * 恢复前读出 manifest 供展示。整个文件读进内存再解中央目录：个人规模的数据目录不大，
 * 摘要这步不值得再实现一份按区间读的 Reader；真正的恢复仍走 restoreArchive 的流式读取。
 */
async function readManifestSummary(backupFile: string, password?: string): Promise<BackupManifest> {
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(backupFile);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new KhError("not_found", `备份文件不存在：${path.basename(backupFile)}`);
    }
    throw e;
  }
  const reader = new ZipReader(new Uint8ArrayReader(bytes), { password: password || undefined });
  let entry: Entry | undefined;
  try {
    const entries = await reader.getEntries().catch((e: unknown) => {
      throw rewriteZipError(e);
    });
    entry = entries.find((item) => item.filename === MANIFEST_NAME);
  } finally {
    await reader.close();
  }
  if (!entry || entry.directory) {
    throw new KhError("invalid", "备份缺少 manifest.json，不是本程序的备份文件");
  }
  let text: string;
  try {
    text = await entry.getData(new TextWriter());
  } catch (e) {
    throw rewriteZipError(e);
  }
  try {
    return JSON.parse(text) as BackupManifest;
  } catch {
    throw new KhError("invalid", "备份的 manifest.json 不是合法的 JSON");
  }
}

/** zip.js 的错误转成中文业务错误。与 backup.ts 的措辞保持一致；zip.js 的错误码不含密码 */
function rewriteZipError(e: unknown): KhError {
  const message = e instanceof Error ? e.message : String(e);
  // 密码错误、解密校验失败，以及拿到加密包却没给密码（zip.js 报 encrypted entry），对使用者是同一件事
  if (
    message.includes(ERR_INVALID_PASSWORD) ||
    message.includes(ERR_INVALID_AUTHENTICATION_CODE) ||
    /encrypted/i.test(message)
  ) {
    return new KhError("invalid", "备份解密失败：密码错误、没有提供密码，或备份文件已损坏");
  }
  return new KhError("invalid", `备份文件读不出来：${message}`);
}

/** 面向使用者的错误信息：业务错误本身就是中文，其余的（如文件系统权限）带上失败上下文 */
function errorText(e: unknown): string {
  if (isKhError(e)) return e.message;
  return `恢复失败：${e instanceof Error ? e.message : String(e)}`;
}

// 直接执行本模块时才进入主流程（vitest 导入时不触发）；argv[1] 可能是符号链接，先解析成真实路径
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const code = await main(process.argv.slice(2));
    // 用 exitCode 而不是 exit()：所有路径都让进程自然结束，stderr 的异步写入（尤其 macOS 管道）先落盘
    if (code !== 0) process.exitCode = code;
  } catch (e) {
    console.error(`恢复失败：${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}
