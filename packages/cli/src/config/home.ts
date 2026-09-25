import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { formatZodError } from "@kanban-hub/core/errors";
import { idSchema } from "@kanban-hub/core/ids";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { CliContext } from "../context";
import { CliError, EXIT } from "../errors";

const CONFIG_FILE = "config.yaml";
const CREDENTIALS_FILE = "credentials";
const CREDENTIALS_MODE = 0o600;
const HOME_DIR_MODE = 0o700;

const machineConfigSchema = z
  .object({
    server: z.string().trim().min(1),
    // logout 之后只保留 server，机器身份两个字段一起清空：要么同时有，要么同时没有
    machineId: idSchema.optional(),
    machineName: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine((cfg) => (cfg.machineId === undefined) === (cfg.machineName === undefined), {
    message: "machineId 和 machineName 必须同时提供或同时不提供",
    path: ["machineName"],
  });

export type MachineConfig = z.infer<typeof machineConfigSchema>;

let tmpSeq = 0;

/** 先写临时文件再重命名，保证不会留下写到一半的文件；mode 未指定时用系统默认权限 */
async function writeFileAtomic(file: string, data: string, mode?: number): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${++tmpSeq}`;
  try {
    await fs.writeFile(tmp, data, mode !== undefined ? { encoding: "utf8", mode } : "utf8");
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

function isNoEntError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === "ENOENT";
}

async function ensureHomeDir(home: string): Promise<void> {
  await fs.mkdir(home, { recursive: true, mode: HOME_DIR_MODE });
  await fs.chmod(home, HOME_DIR_MODE);
}

/**
 * KH_HOME：环境变量优先，否则是主目录下的 .kanban-hub（规格没写的细节：本机配置）。
 * 两种情况都必须落到绝对路径：KH_HOME 给了相对路径是用法错误；找不到主目录（ctx.homeDir
 * 为空或本身不是绝对路径）是意外错误。当前目录若恰好是被管理的仓库，相对路径会和仓库自己的
 * .kanban-hub/config.yaml 撞在一起，违反“kh 只写 KH_HOME”的边界，所以这里不能退让。
 */
export function resolveKhHome(ctx: CliContext): string {
  const override = ctx.env.KH_HOME;
  if (override !== undefined && override.trim() !== "") {
    if (!path.isAbsolute(override)) {
      throw new CliError(EXIT.USAGE, `KH_HOME 必须是绝对路径：${override}`);
    }
    return override;
  }

  if (ctx.homeDir === "" || !path.isAbsolute(ctx.homeDir)) {
    throw new CliError(EXIT.UNEXPECTED, "找不到当前用户的主目录", "可以设置环境变量 KH_HOME 指定 kh 的本机数据目录");
  }
  return path.join(ctx.homeDir, ".kanban-hub");
}

/** 读取本机配置；没有登录过（文件不存在）返回 null，文件损坏或不合法一律抛用法错误 */
export async function readMachineConfig(home: string): Promise<MachineConfig | null> {
  const filePath = path.join(home, CONFIG_FILE);
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
    throw new CliError(EXIT.USAGE, `本机配置文件损坏，无法解析：${filePath}（${reason}）`, "删除该文件后重新执行 kh login");
  }

  const result = machineConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = formatZodError(result.error).join("；");
    throw new CliError(EXIT.USAGE, `本机配置文件不符合格式：${filePath}（${issues}）`, "删除该文件后重新执行 kh login");
  }
  return result.data;
}

/** 写入本机配置：先按 schema 校验，再原子写入；目录不存在会自动创建成 700 */
export async function writeMachineConfig(home: string, cfg: MachineConfig): Promise<void> {
  const validated = machineConfigSchema.parse(cfg);
  await ensureHomeDir(home);
  await writeFileAtomic(path.join(home, CONFIG_FILE), stringifyYaml(validated));
}

/**
 * 读取本机保存的令牌。发现 credentials 的权限比 600 宽时改回 600，并在 stderr 提示一行；
 * 令牌只应该出现在这一个文件里，所以这里需要 ctx 来输出提示（不经 ctx 无法安全地报告这类修复）。
 * Windows 上权限位不生效，跳过检查和修复，避免每次读取都误报。
 */
export async function readToken(home: string, ctx: CliContext): Promise<string | null> {
  const filePath = path.join(home, CREDENTIALS_FILE);
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(filePath);
  } catch (err) {
    if (isNoEntError(err)) return null;
    throw err;
  }

  if (ctx.platform !== "win32") {
    const mode = stat.mode & 0o777;
    if (mode !== CREDENTIALS_MODE) {
      await fs.chmod(filePath, CREDENTIALS_MODE);
      ctx.stderr.write(`已把 ${filePath} 的权限从 ${mode.toString(8)} 改回 600，避免令牌被其他用户读取\n`);
    }
  }

  const raw = await fs.readFile(filePath, "utf8");
  const token = raw.trim();
  return token === "" ? null : token;
}

/** 写入令牌：目录不存在会自动创建成 700，文件权限固定为 600（Windows 上这个 mode 不生效，但传了无害） */
export async function writeToken(home: string, token: string): Promise<void> {
  await ensureHomeDir(home);
  await writeFileAtomic(path.join(home, CREDENTIALS_FILE), `${token}\n`, CREDENTIALS_MODE);
}

async function removeCredentialsFile(home: string): Promise<void> {
  try {
    await fs.rm(path.join(home, CREDENTIALS_FILE));
  } catch (err) {
    if (!isNoEntError(err)) throw err;
  }
}

/**
 * logout 用：删除本机令牌，并把本机配置改写成只保留服务端地址（机器身份不该继续留在本机）。
 * 凭据文件、配置文件本来就不存在都不算错误；两者都不存在时整体视为成功（幂等，可以放心重复调用）。
 */
export async function clearMachineIdentity(home: string): Promise<void> {
  await removeCredentialsFile(home);
  const cfg = await readMachineConfig(home);
  if (cfg !== null) await writeMachineConfig(home, { server: cfg.server });
}
