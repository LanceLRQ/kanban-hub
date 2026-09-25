import fs from "node:fs/promises";
import path from "node:path";
import { formatZodError } from "@kanban-hub/core/errors";
import { idSchema } from "@kanban-hub/core/ids";
import { syncScopeSchema, type SyncScope } from "@kanban-hub/core/schema";
import { SYNC_DEFAULT_MAX_FILE_SIZE, SYNC_MAX_FILE_SIZE_LIMIT } from "@kanban-hub/core/sync";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { CliError, EXIT } from "../errors";
import { isNoEntError, writeFileAtomic } from "./fs-utils";

const REPO_CONFIG_DIR = ".kanban-hub";
const REPO_CONFIG_FILE = "config.yaml";
const CONFIG_HEADER = [
  "# kanban-hub 的仓库配置文件",
  "# 默认不会被提交到 git；想让它入库时执行：git add -f .kanban-hub",
].join("\n");

const BYTE_SIZE_PATTERN = /^(-?\d+(?:\.\d+)?)\s*(b|kb|mb)?$/i;

/** 把 "5MB"、"500kb"、"1024"（字节数）或裸数字换算成字节数；不合法时抛纯 Error，由外层包装 */
function parseByteSizeCore(input: string | number): number {
  let bytes: number;
  if (typeof input === "number") {
    bytes = input;
  } else {
    const match = BYTE_SIZE_PATTERN.exec(input.trim());
    if (match === null) {
      throw new Error(`无法识别的大小写法：${input}`);
    }
    const numStr = match[1] ?? "0";
    const unit = (match[2] ?? "b").toLowerCase();
    const multiplier = unit === "mb" ? 1024 * 1024 : unit === "kb" ? 1024 : 1;
    bytes = Math.round(Number(numStr) * multiplier);
  }

  if (!Number.isFinite(bytes) || bytes <= 0) {
    throw new Error(`大小必须是正数：${input}`);
  }
  if (!Number.isInteger(bytes)) {
    throw new Error(`大小必须是整数字节：${input}`);
  }
  if (bytes > SYNC_MAX_FILE_SIZE_LIMIT) {
    throw new Error(`大小不能超过 ${formatByteSize(SYNC_MAX_FILE_SIZE_LIMIT)}：${input}`);
  }
  return bytes;
}

/** 把 "5MB"、"500kb"、"1024" 或裸数字换算成字节数；单位不认识、负数、超过 20MB 硬上限都报用法错误 */
export function parseByteSize(input: string | number): number {
  try {
    return parseByteSizeCore(input);
  } catch (err) {
    throw new CliError(EXIT.USAGE, err instanceof Error ? err.message : String(err));
  }
}

/** 字节数换算成易读写法：能整除 MB/KB 就用对应单位，否则用字节数 */
export function formatByteSize(bytes: number): string {
  if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)}MB`;
  if (bytes % 1024 === 0) return `${bytes / 1024}KB`;
  return `${bytes}B`;
}

const maxFileSizeField = z
  .union([z.string().min(1), z.number()])
  .default(SYNC_DEFAULT_MAX_FILE_SIZE)
  .superRefine((value, ctx) => {
    try {
      parseByteSizeCore(value);
    } catch (err) {
      ctx.addIssue({ code: "custom", message: err instanceof Error ? err.message : String(err) });
    }
  });

/** .kanban-hub/config.yaml 的形状；读取时忽略未知字段 */
export const repoConfigSchema = z.object({
  projectId: idSchema,
  sync: z.object({
    include: z.array(z.string().min(1)),
    exclude: z.array(z.string().min(1)).default([]),
    maxFileSize: maxFileSizeField,
  }),
  pull: z
    .object({
      auto: z.boolean().default(true),
    })
    .default({ auto: true }),
});
export type RepoConfig = z.infer<typeof repoConfigSchema>;

function repoConfigPath(root: string): string {
  return path.join(root, REPO_CONFIG_DIR, REPO_CONFIG_FILE);
}

/** 读取仓库配置；没有该文件返回 null，文件损坏或不符合格式抛用法错误 */
export async function readRepoConfig(root: string): Promise<RepoConfig | null> {
  const filePath = repoConfigPath(root);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (isNoEntError(err)) return null;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new CliError(EXIT.USAGE, `仓库配置文件损坏，无法解析：${filePath}（${reason}）`);
  }

  const result = repoConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = formatZodError(result.error).join("；");
    throw new CliError(EXIT.USAGE, `仓库配置文件不符合格式：${filePath}（${issues}）`);
  }
  return result.data;
}

/** 写入仓库配置：先按 schema 校验再原子写入，并创建 .kanban-hub/；文件开头带两行说明性注释 */
export async function writeRepoConfig(root: string, config: RepoConfig): Promise<void> {
  const validated = repoConfigSchema.parse(config);
  const dir = path.join(root, REPO_CONFIG_DIR);
  await fs.mkdir(dir, { recursive: true });
  const body = stringifyYaml(validated);
  await writeFileAtomic(repoConfigPath(root), `${CONFIG_HEADER}\n\n${body}`);
}

/** 仓库配置换算成 API/存储层用的 SyncScope：maxFileSize 换算成字节 */
export function toSyncScope(config: RepoConfig): SyncScope {
  return syncScopeSchema.parse({
    include: config.sync.include,
    exclude: config.sync.exclude,
    maxFileSize: parseByteSize(config.sync.maxFileSize),
  });
}
