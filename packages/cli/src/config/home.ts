import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { machineTokenSchema } from "@kanban-hub/core/api";
import { formatZodError } from "@kanban-hub/core/errors";
import { idSchema } from "@kanban-hub/core/ids";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { CliContext } from "../context";
import { CliError, EXIT } from "../errors";

const CONFIG_FILE = "config.yaml";
const CREDENTIALS_FILE = "credentials";
const CREDENTIALS_MODE = 0o600;
const HOME_DIR_MODE = 0o700;

/** 去掉 URL 里 "user:pass@" 形式的账号密码；解析失败时也能用，纯字符串匹配，不依赖 URL 类 */
function redactUserinfo(raw: string): string {
  return raw.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/?#]*@/, "$1");
}

/**
 * 服务端地址的合法性规则：只接受 http/https 的 origin——不带用户名密码、path 只能为空或 "/"、
 * 不带 query/hash，返回规范化后的 origin（不带结尾 /）。kh login 的 --server 和本机配置里
 * 保存的 server 共用这一份规则，保证“先校验再写”，也保证两处的存储格式一致。
 *
 * 错误信息里不回显账号密码：判断账号密码是否存在这一步放在最前面，其余分支即便回显原始
 * 地址，也已经确认过不含账号密码；万一地址本身连 URL 都解析不出来，也用 redactUserinfo
 * 兜底去掉看起来像账号密码的部分，不能假设“解析失败”就等于“不含敏感信息”。
 */
export function normalizeServerOrigin(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new CliError(EXIT.USAGE, `服务端地址不合法：${redactUserinfo(raw)}`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new CliError(EXIT.USAGE, "服务端地址不能包含用户名或密码", `只保留 ${parsed.protocol}//${parsed.host}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CliError(EXIT.USAGE, `服务端地址必须是 http 或 https：${raw}`);
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new CliError(EXIT.USAGE, `服务端地址不能带路径：${raw}`);
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new CliError(EXIT.USAGE, `服务端地址不能带查询参数或锚点：${raw}`);
  }
  return parsed.origin;
}

const machineConfigSchema = z
  .object({
    // 与 normalizeServerOrigin 用同一份规则：本机配置文件被手改成非法地址时，也要在这里
    // 拦成用法错误（2，本机配置损坏），而不是等到发请求时 `new URL` 在 try 之外抛出英文异常
    server: z.string().superRefine((value, ctx) => {
      try {
        normalizeServerOrigin(value);
      } catch (err) {
        ctx.addIssue({ code: "custom", message: err instanceof Error ? err.message : String(err) });
      }
    }),
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
 * KH_HOME：环境变量优先，否则是主目录下的 .kanban-hub。
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

const LOGIN_HINT_NO_SERVER = "kh login --server <地址> --code <配对码>";

/**
 * “重新登录”提示：本机配置里已经有服务端地址时，提示去 /setup 取配对码（kh login 省略
 * --server 时会沿用已保存的地址）；一次都没配置过服务端地址时给出带 --server 的完整命令。
 * requireLogin（尚未登录）和 readToken（凭据文件损坏）共用这份提示逻辑。
 */
export function loginHint(server: string | undefined): string {
  return server !== undefined ? `到 ${server}/setup 取配对码，再执行 kh login --code <配对码>` : LOGIN_HINT_NO_SERVER;
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
  if (token === "") return null;
  if (!machineTokenSchema.safeParse(token).success) {
    // 不回显文件内容：令牌格式不对多半是文件被手改坏了，回显反而可能把半个令牌打到 stderr 里。
    // 本机配置本身可能也读不出来（两个文件都被手改坏了），读不到就退化成不带地址的提示
    const cfg = await readMachineConfig(home).catch(() => null);
    throw new CliError(EXIT.USAGE, "本机凭据文件损坏", loginHint(cfg?.server));
  }
  return token;
}

/** 写入令牌：先校验格式再写，目录不存在会自动创建成 700，文件权限固定为 600（Windows 上这个 mode 不生效，但传了无害） */
export async function writeToken(home: string, token: string): Promise<void> {
  if (!machineTokenSchema.safeParse(token).success) {
    throw new CliError(EXIT.UNEXPECTED, "服务端返回的令牌格式不正确");
  }
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
