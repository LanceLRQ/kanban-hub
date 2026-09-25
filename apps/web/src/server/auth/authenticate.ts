import type { Actor, Machine, User } from "@kanban-hub/core/schema";
import type { AuthRepo } from "../store/auth";
import { SESSION_COOKIE, readCookie, verifySession } from "./session";
import { hashToken, isMachineTokenFormat } from "./token";

/** 判断 Authorization 头的 scheme 是不是 Bearer，不关心后面的值是否合法 */
const BEARER_SCHEME_PATTERN = /^Bearer(\s|$)/i;
const BEARER_PATTERN = /^Bearer\s+(\S+)$/i;

export interface LastSeenTrackerOptions {
  now: () => Date;
  log: (message: string) => void;
  intervalMs?: number;
}

/**
 * 令牌鉴权成功后更新机器的 lastSeenAt：节流到每台机器至多每 intervalMs 写一次，
 * 同一台机器同一时间最多一个待写入。返回的 Promise 总会 resolve（写入失败只记日志），
 * 调用方不需要等待它——touch 本身不阻塞请求。
 */
export class LastSeenTracker {
  private readonly now: () => Date;
  private readonly log: (message: string) => void;
  private readonly intervalMs: number;
  /** 每台机器最近一次成功写入的时间（毫秒），用于节流 */
  private readonly lastWriteAt = new Map<string, number>();
  /** 每台机器当前是否有一个写入在途，用于合并并发请求 */
  private readonly pending = new Set<string>();

  constructor(opts: LastSeenTrackerOptions) {
    this.now = opts.now;
    this.log = opts.log;
    this.intervalMs = opts.intervalMs ?? 60_000;
  }

  touch(machine: Machine, auth: AuthRepo): Promise<void> {
    const nowMs = this.now().getTime();
    const last = this.lastWriteAt.get(machine.id);
    if (this.pending.has(machine.id) || (last !== undefined && nowMs - last < this.intervalMs)) {
      return Promise.resolve();
    }

    this.pending.add(machine.id);
    return auth
      .updateMachine(machine.id, { lastSeenAt: new Date(nowMs).toISOString() })
      .then(() => {
        this.lastWriteAt.set(machine.id, nowMs);
      })
      .catch((e: unknown) => {
        this.log(`更新机器 ${machine.id} 的最近活跃时间失败：${e instanceof Error ? e.message : String(e)}`);
      })
      .finally(() => {
        this.pending.delete(machine.id);
      });
  }
}

/** 请求鉴权后得到的操作者：会话来自网页登录，机器来自 kh 的令牌 */
export type Principal = { kind: "session"; user: User } | { kind: "machine"; user: User; machine: Machine };

export interface AuthenticateDeps {
  auth: AuthRepo;
  now: () => Date;
  seen: LastSeenTracker;
}

/**
 * 从请求里解析出操作者。Authorization 的 scheme 是 Bearer（大小写不敏感）就只按令牌鉴权，
 * 不再看 cookie，哪怕令牌本身格式不对、查不到、已吊销也不回退。
 * 其他 scheme（例如反向代理加的 HTTP Basic）或没有 Authorization 头，都按会话 cookie 鉴权。
 * 两种方式失败都返回 null，不抛错。
 */
export async function authenticate(req: Request, deps: AuthenticateDeps): Promise<Principal | null> {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== null && BEARER_SCHEME_PATTERN.test(authHeader.trim())) {
    return authenticateByToken(authHeader, deps);
  }
  return authenticateBySession(req.headers.get("cookie"), deps);
}

/** 鉴权得到的操作者转换为落盘用的 Actor；agent 只对令牌鉴权生效，会话操作者恒为 null */
export function toActor(principal: Principal, agent: string | null): Actor {
  if (principal.kind === "session") return { userId: principal.user.id, machineId: null, via: "web", agent: null };
  return { userId: principal.user.id, machineId: principal.machine.id, via: "cli", agent };
}

async function authenticateByToken(authHeader: string, deps: AuthenticateDeps): Promise<Principal | null> {
  const match = BEARER_PATTERN.exec(authHeader.trim());
  const token = match?.[1];
  if (token === undefined || !isMachineTokenFormat(token)) return null;

  const machine = deps.auth.findMachineByTokenHash(hashToken(token));
  if (!machine || machine.revokedAt !== null) return null;

  const user = deps.auth.getUser(machine.userId);
  if (!user) return null;

  // 不等待：lastSeenAt 的更新不应该拖慢这次请求，失败也只在 LastSeenTracker 内部记日志
  void deps.seen.touch(machine, deps.auth);
  return { kind: "machine", user, machine };
}

/** 会话校验只需要用到的那部分依赖：网页会话不涉及机器令牌，不需要 seen tracker */
export interface VerifySessionCookieDeps {
  auth: Pick<AuthRepo, "sessionSecret" | "getUser">;
  now: () => Date;
}

/**
 * 只接收 cookie 值（不是整段 Cookie 请求头）校验网页会话，返回对应的用户。
 * 签名不对、格式不对、已过期、sessionVersion 不匹配（改密码后旧会话失效）、
 * 用户不存在，都返回 null；cookie 值本身为 null（未登录）也返回 null。
 * 供 server/web/session.ts 的 getPageSession 使用，也是这个函数单元测试的入口——
 * 不依赖 Next 的请求上下文，直接传入 cookie 值即可。
 */
export function verifySessionCookie(value: string | null, deps: VerifySessionCookieDeps): { user: User } | null {
  if (value === null) return null;

  const payload = verifySession(value, deps.auth.sessionSecret(), deps.now().getTime());
  if (!payload) return null;

  const user = deps.auth.getUser(payload.userId);
  if (!user || user.sessionVersion !== payload.sessionVersion) return null;

  return { user };
}

function authenticateBySession(cookieHeader: string | null, deps: AuthenticateDeps): Principal | null {
  const value = readCookie(cookieHeader, SESSION_COOKIE);
  const result = verifySessionCookie(value, deps);
  return result ? { kind: "session", user: result.user } : null;
}
