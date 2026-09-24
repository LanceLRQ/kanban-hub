import { HEADER_KH_AGENT, HEADER_KH_VERSION } from "@kanban-hub/core/api";
import type { Actor } from "@kanban-hub/core/schema";
import { KH_VERSION } from "@kanban-hub/core/version";
import { authenticate, toActor, type Principal } from "../auth/authenticate";
import { readCookie, SESSION_COOKIE } from "../auth/session";
import type { Services } from "../services";
import { getServices } from "../services";
import { ApiError, toErrorResponse } from "./errors";
import { checkClientVersion, isSameOrigin } from "./http";

/** 请求里是否带了 Authorization: Bearer（大小写不敏感），不关心令牌本身是否合法 */
const BEARER_SCHEME_PATTERN = /^Bearer(\s|$)/i;
/** X-KH-Agent 允许的最大长度，与 core 的 actorSchema 一致 */
const MAX_AGENT_LENGTH = 50;

export type ApiAuthMode = "none" | "session" | "machine" | "any";

export interface ApiRouteOptions<Auth extends ApiAuthMode> {
  /**
   * - none：不鉴权，principal/actor 恒为 null；
   * - session：只接受网页会话，遇到令牌请求返回 403；
   * - machine：只接受 kh 的机器令牌，遇到会话请求返回 403；
   * - any：两种都接受。
   */
  auth: Auth;
}

/** 按 auth 模式收窄 principal 的类型：session/machine 分别只保留对应的那一支，any 是完整联合 */
type PrincipalFor<Auth extends ApiAuthMode> = Auth extends "none"
  ? null
  : Auth extends "session"
    ? Extract<Principal, { kind: "session" }>
    : Auth extends "machine"
      ? Extract<Principal, { kind: "machine" }>
      : Principal;

/** none 模式恒为 null，其余模式鉴权通过后 actor 一定存在 */
type ActorFor<Auth extends ApiAuthMode> = Auth extends "none" ? null : Actor;

/** 没有动态段的路由，params 是空对象 */
type EmptyParams = Record<string, never>;

export interface ApiRouteArgs<Auth extends ApiAuthMode, Params extends Record<string, unknown> = EmptyParams> {
  req: Request;
  params: Params;
  principal: PrincipalFor<Auth>;
  actor: ActorFor<Auth>;
  services: Services;
}

export type ApiRouteHandler<Auth extends ApiAuthMode, Params extends Record<string, unknown> = EmptyParams> = (
  args: ApiRouteArgs<Auth, Params>,
) => Promise<Response> | Response;

/** 给动态段路由标注处理函数参数用的快捷别名，省得每次都写一遍 `ApiRouteArgs<"machine", ...>` */
export type NoneRouteArgs<Params extends Record<string, unknown> = EmptyParams> = ApiRouteArgs<"none", Params>;
export type SessionRouteArgs<Params extends Record<string, unknown> = EmptyParams> = ApiRouteArgs<"session", Params>;
export type MachineRouteArgs<Params extends Record<string, unknown> = EmptyParams> = ApiRouteArgs<"machine", Params>;
export type AnyRouteArgs<Params extends Record<string, unknown> = EmptyParams> = ApiRouteArgs<"any", Params>;

type RouteContextLike<Params> = { params: Promise<Params> };

/**
 * 所有 /api/v1 路由共用的外壳，按固定顺序执行：
 * 版本检查（426）→ 取服务容器（503）→ 按 auth 模式鉴权（401/403）→
 * 会话写请求的同源校验（403）→ 生成 actor → 调用处理函数 → 统一错误映射。
 *
 * 返回的函数可以直接作为路由方法导出（`export const POST = apiRoute(...)`），
 * 第二个参数兼容 Next 的 RouteContext（ctx.params 是 Promise）；
 * 第一个参数声明为 Request 而不是 NextRequest，两边都满足：Next 运行时传入的
 * NextRequest 是 Request 的子类型，测试里也能直接传普通 Request。
 *
 * 处理函数里 principal/actor 的类型随 `auth` 变化：none 恒为 null，session/machine
 * 收窄到对应的那一支 Principal，any 是完整联合。不带动态段的路由不需要写任何泛型参数，
 * 直接 `apiRoute({ auth: "machine" }, ({ principal }) => ...)` 就能推断出来；有动态段时，
 * 给处理函数的参数标注 `MachineRouteArgs<{ id: string }>`（或 `SessionRouteArgs`/`AnyRouteArgs`/
 * `NoneRouteArgs`）即可同时拿到 params 的类型——标注的 auth 和 options.auth 不一致会报类型错误。
 */
export function apiRoute<Auth extends ApiAuthMode, Params extends Record<string, unknown> = EmptyParams>(
  options: ApiRouteOptions<Auth>,
  handler: ApiRouteHandler<Auth, Params>,
): (req: Request, ctx?: RouteContextLike<Params>) => Promise<Response> {
  return async (req: Request, ctx?: RouteContextLike<Params>): Promise<Response> => {
    let log: (message: string) => void = defaultLog;
    try {
      const versionError = checkClientVersion(req.headers.get(HEADER_KH_VERSION));
      if (versionError) throw versionError;

      const services = getServices();
      log = services.log;

      const principal = await resolvePrincipal(req, options.auth, services);

      if (principal?.kind === "session" && req.method !== "GET" && !isSameOrigin(req, services.publicUrl)) {
        throw new ApiError("forbidden", "请求来源不受信任，请从网页本身发起操作");
      }

      const actor = principal ? toActor(principal, principal.kind === "machine" ? readAgent(req) : null) : null;

      const params = ctx ? await ctx.params : ({} as Params);
      // resolvePrincipal 已经按 auth 模式校验过凭据种类，这里的运行时值一定和 Auth 对应；
      // TS 推不出这层对应关系，只在外壳内部断言一次，处理函数那边不需要再收窄
      const res = await handler({
        req,
        params,
        principal: principal as PrincipalFor<Auth>,
        actor: actor as ActorFor<Auth>,
        services,
      });
      res.headers.set("X-KH-Version", KH_VERSION);
      return res;
    } catch (e) {
      return toErrorResponse(e, log);
    }
  };
}

/** 按 auth 模式解析操作者；模式不匹配的凭据抛 403，没有可用凭据抛 401 */
async function resolvePrincipal(req: Request, auth: ApiAuthMode, services: Services): Promise<Principal | null> {
  if (auth === "none") return null;

  const isTokenAttempt = BEARER_SCHEME_PATTERN.test((req.headers.get("authorization") ?? "").trim());
  const isSessionAttempt = readCookie(req.headers.get("cookie"), SESSION_COOKIE) !== null;

  if (auth === "session" && isTokenAttempt) throw new ApiError("forbidden", "只能在网页上操作");
  if (auth === "machine" && isSessionAttempt) throw new ApiError("forbidden", "只能用 kh 命令行工具操作");

  const principal = await authenticate(req, { auth: services.store.auth, now: services.now, seen: services.seen });
  if (!principal) {
    // 带了令牌但校验不通过：令牌本身失效/被吊销，恢复手段是重新配对（规格 9 节的 kh login），
    // 不是 kh setup（那只装 skill/hook，规格 12.1），提示错了会让人以为跑 kh setup 就能恢复
    if (isTokenAttempt) {
      throw new ApiError("unauthorized", "机器令牌无效或已被吊销，请到网页的 /setup 页面获取配对码，再执行 kh login 重新接入");
    }
    throw new ApiError("unauthorized", "登录已失效，请重新登录");
  }
  return principal;
}

/** 只对令牌鉴权的请求生效：去掉首尾空白后为空当作没有，超过 50 个字符报 invalid */
function readAgent(req: Request): string | null {
  const raw = req.headers.get(HEADER_KH_AGENT);
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (trimmed.length > MAX_AGENT_LENGTH) throw new ApiError("invalid", `X-KH-Agent 不能超过 ${MAX_AGENT_LENGTH} 个字符`);
  return trimmed;
}

function defaultLog(message: string): void {
  console.error(`[kanban-hub] ${message}`);
}
