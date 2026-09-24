import fs from "node:fs/promises";
import path from "node:path";
import { type Document, LineCounter, isNode, parseDocument, stringify } from "yaml";
import type { z } from "zod";
import { formatPath } from "@kanban-hub/core/errors";

/** 数据文件读取失败：指出文件和行号，启动时据此拒绝启动（规格第 15 节） */
export class DataFileError extends Error {
  constructor(
    readonly file: string,
    readonly line: number | null,
    readonly reason: string,
  ) {
    super(line !== null ? `${file} 第 ${line} 行：${reason}` : `${file}：${reason}`);
    this.name = "DataFileError";
  }
}

/** 第一条校验问题：字段路径（去掉 symbol，供定位行号）与“字段路径：原因”文案 */
function firstIssue(error: z.ZodError): { keys: (string | number)[]; reason: string } {
  const issue = error.issues[0]!;
  const keys = issue.path.filter((k): k is string | number => typeof k !== "symbol");
  return { keys, reason: keys.length > 0 ? `${formatPath(keys)}：${issue.message}` : issue.message };
}

let tmpSeq = 0;

/** 先写同目录下的临时文件并落盘，再重命名替换，保证不会出现写了一半的文件 */
export async function writeFileAtomic(file: string, data: string, opts: { mode?: number } = {}): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  // 临时文件以 .tmp-<pid>-<序号> 结尾，数据目录的 .gitignore 排除了这类文件
  const tmp = `${file}.tmp-${process.pid}-${++tmpSeq}`;
  try {
    const handle = await fs.open(tmp, "w", opts.mode ?? 0o644);
    try {
      await handle.writeFile(data, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

/** 读取并校验 YAML 数据文件；文件不存在返回 null。格式或校验错误抛出带行号的 DataFileError */
export async function readYamlFile<T>(file: string, schema: z.ZodType<T>): Promise<T | null> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  return parseYamlText(file, text, schema);
}

export function parseYamlText<T>(file: string, text: string, schema: z.ZodType<T>): T {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter });
  const syntaxError = doc.errors[0];
  if (syntaxError) {
    const line = lineCounter.linePos(syntaxError.pos[0]).line;
    throw new DataFileError(file, line, `YAML 格式错误：${syntaxError.message.split("\n")[0]}`);
  }
  const result = schema.safeParse(doc.toJS());
  if (result.success) return result.data;
  const { keys, reason } = firstIssue(result.error);
  throw new DataFileError(file, lineOfPath(doc, lineCounter, keys), reason);
}

/** 出错字段所在的行；字段不存在时退到它的上一层 */
function lineOfPath(doc: Document, lineCounter: LineCounter, keys: (string | number)[]): number | null {
  for (let n = keys.length; n >= 0; n--) {
    const node = n === 0 ? doc.contents : doc.getIn(keys.slice(0, n), true);
    if (isNode(node) && node.range) return lineCounter.linePos(node.range[0]).line;
  }
  return null;
}

/** 写 YAML 数据文件：不折行、不用锚点别名（同一个对象出现两次也展开写），方便看 git diff */
export async function writeYamlFile(file: string, value: unknown, opts: { mode?: number } = {}): Promise<void> {
  await writeFileAtomic(file, stringify(value, { lineWidth: 0, aliasDuplicateObjects: false }), opts);
}

export interface JsonLines<T> {
  items: T[];
  /** clean：以换行结尾；unterminated：最后一行完整但缺换行；partial：最后一行写到一半 */
  tail: "clean" | "unterminated" | "partial";
  /** 最后一个完整行结束处的字节数，截掉残行时用 */
  validBytes: number;
}

/** 读取 JSONL：中间的坏行报错并指出行号；末尾的残行交给调用方决定是否修复 */
export async function readJsonLines<T>(file: string, schema: z.ZodType<T>): Promise<JsonLines<T>> {
  let buf: Buffer;
  try {
    buf = await fs.readFile(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { items: [], tail: "clean", validBytes: 0 };
    throw e;
  }
  const lastNewline = buf.lastIndexOf(0x0a);
  const lines = buf.subarray(0, lastNewline + 1).toString("utf8").split("\n");
  const items: T[] = [];
  lines.forEach((line, index) => {
    if (line.trim() !== "") items.push(parseJsonLine(file, index + 1, line, schema));
  });
  const rest = buf.subarray(lastNewline + 1).toString("utf8");
  if (rest.trim() === "") return { items, tail: "clean", validBytes: buf.length };
  try {
    JSON.parse(rest);
  } catch {
    // JSON 不完整：崩溃时写到一半的残行，交给调用方截掉
    return { items, tail: "partial", validBytes: lastNewline + 1 };
  }
  // 完整的一行只是缺换行：照常校验，不合法就报错，不能当残行截掉
  items.push(parseJsonLine(file, lines.length, rest, schema));
  return { items, tail: "unterminated", validBytes: buf.length };
}

function parseJsonLine<T>(file: string, lineNo: number, line: string, schema: z.ZodType<T>): T {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new DataFileError(file, lineNo, "不是合法的 JSON");
  }
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new DataFileError(file, lineNo, firstIssue(result.error).reason);
}

/** 修复 JSONL 文件末尾：补上缺失的换行，或截掉写到一半的残行 */
export async function repairJsonLinesTail(file: string, lines: JsonLines<unknown>): Promise<void> {
  if (lines.tail === "unterminated") await fs.appendFile(file, "\n");
  else if (lines.tail === "partial") await fs.truncate(file, lines.validBytes);
}

/** 追加一行 JSON */
export async function appendJsonLine(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(value)}\n`, "utf8");
}
