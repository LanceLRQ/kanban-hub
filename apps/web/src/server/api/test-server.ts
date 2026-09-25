/**
 * 测试专用：在 node:http 上挂载 apps/web/src/app 下全部路由处理函数，供端到端测试
 * （apps/web/src/kh-e2e/*）通过真实网络请求驱动 kh 的 main()。
 *
 * 路由表必须和磁盘上的 route.ts 一一对应，test-server.test.ts 用 glob 比对，新增路由
 * 忘记登记会让那个测试失败。每个处理函数就是普通的 (req: Request, ctx) => Response，
 * 不依赖 Next 的运行时，直接把 apps/web/src/app 下导出的 GET/POST/... 接进来即可。
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { GET as healthGet } from "@/app/api/health/route";
import { POST as authLoginPost } from "@/app/api/v1/auth/login/route";
import { POST as authLogoutPost } from "@/app/api/v1/auth/logout/route";
import { GET as eventsGet } from "@/app/api/v1/events/route";
import { POST as machineRevokePost } from "@/app/api/v1/machines/[id]/revoke/route";
import { GET as machinesGet } from "@/app/api/v1/machines/route";
import { GET as meGet } from "@/app/api/v1/me/route";
import { POST as pairPost } from "@/app/api/v1/pair/route";
import { POST as pairingCodesPost } from "@/app/api/v1/pairing-codes/route";
import { PATCH as containerPatch } from "@/app/api/v1/projects/[id]/containers/[cid]/route";
import { POST as containersPost } from "@/app/api/v1/projects/[id]/containers/route";
import { PUT as locationPut } from "@/app/api/v1/projects/[id]/locations/[machineId]/route";
import { POST as logPost } from "@/app/api/v1/projects/[id]/log/route";
import { GET as projectGet, PATCH as projectPatch } from "@/app/api/v1/projects/[id]/route";
import { PATCH as taskPatch } from "@/app/api/v1/projects/[id]/tasks/[tid]/route";
import { POST as tasksPost } from "@/app/api/v1/projects/[id]/tasks/route";
import { GET as projectsGet, POST as projectsPost } from "@/app/api/v1/projects/route";
import { GET as streamGet } from "@/app/api/v1/stream/route";
import { GET as khTgzGet } from "@/app/setup/kh.tgz/route";

import { setupTestApi, type TestApi } from "./testing";

type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** 路由表登记用的处理函数形状：动态段的 params 统一按 Record<string, string> 传递 */
type RouteHandler = (
  req: Request,
  ctx: { params: Promise<Record<string, string>> },
) => Response | Promise<Response>;

interface RouteEntry {
  /** URL 写法，动态段用 :name（对应磁盘上的 [name]），比如 /api/v1/projects/:id/tasks/:tid */
  pattern: string;
  handlers: Partial<Record<HttpMethod, RouteHandler>>;
}

/**
 * 各 route.ts 导出的处理函数，params 的具体形状各不相同（有的没有动态段，有的有一到两个），
 * 这里统一收窄成 RouteHandler（params: Record<string, string>）：路由表只在意“这个 URL 交给
 * 哪个函数”，具体是哪些 key 由 pattern 自己保证，实际调用时传入的 params 一定和处理函数期望的
 * 键一致，只是 TS 推不出这层对应关系。
 */
function asRouteHandler(fn: (req: Request, ctx: { params: Promise<never> }) => Response | Promise<Response>): RouteHandler {
  return fn as unknown as RouteHandler;
}

/** 路由表：必须覆盖 apps/web/src/app 下每一个 route.ts，见 test-server.test.ts 的比对测试 */
const ROUTES: RouteEntry[] = [
  { pattern: "/api/health", handlers: { GET: asRouteHandler(healthGet) } },
  { pattern: "/api/v1/auth/login", handlers: { POST: asRouteHandler(authLoginPost) } },
  { pattern: "/api/v1/auth/logout", handlers: { POST: asRouteHandler(authLogoutPost) } },
  { pattern: "/api/v1/events", handlers: { GET: asRouteHandler(eventsGet) } },
  { pattern: "/api/v1/machines", handlers: { GET: asRouteHandler(machinesGet) } },
  { pattern: "/api/v1/machines/:id/revoke", handlers: { POST: asRouteHandler(machineRevokePost) } },
  { pattern: "/api/v1/me", handlers: { GET: asRouteHandler(meGet) } },
  { pattern: "/api/v1/pair", handlers: { POST: asRouteHandler(pairPost) } },
  { pattern: "/api/v1/pairing-codes", handlers: { POST: asRouteHandler(pairingCodesPost) } },
  { pattern: "/api/v1/projects", handlers: { GET: asRouteHandler(projectsGet), POST: asRouteHandler(projectsPost) } },
  { pattern: "/api/v1/projects/:id", handlers: { GET: asRouteHandler(projectGet), PATCH: asRouteHandler(projectPatch) } },
  { pattern: "/api/v1/projects/:id/containers", handlers: { POST: asRouteHandler(containersPost) } },
  { pattern: "/api/v1/projects/:id/containers/:cid", handlers: { PATCH: asRouteHandler(containerPatch) } },
  { pattern: "/api/v1/projects/:id/locations/:machineId", handlers: { PUT: asRouteHandler(locationPut) } },
  { pattern: "/api/v1/projects/:id/log", handlers: { POST: asRouteHandler(logPost) } },
  { pattern: "/api/v1/projects/:id/tasks", handlers: { POST: asRouteHandler(tasksPost) } },
  { pattern: "/api/v1/projects/:id/tasks/:tid", handlers: { PATCH: asRouteHandler(taskPatch) } },
  { pattern: "/api/v1/stream", handlers: { GET: asRouteHandler(streamGet) } },
  { pattern: "/setup/kh.tgz", handlers: { GET: asRouteHandler(khTgzGet) } },
];

function segmentsOf(pattern: string): string[] {
  return pattern.split("/").filter((s) => s !== "");
}

/** pathname 按 pattern 逐段匹配；:name 段捕获成参数，其余段必须完全相等 */
function matchPattern(pathname: string, pattern: string): Record<string, string> | null {
  const actual = segmentsOf(pathname);
  const wanted = segmentsOf(pattern);
  if (actual.length !== wanted.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < wanted.length; i++) {
    const want = wanted[i]!;
    const got = actual[i]!;
    if (want.startsWith(":")) params[want.slice(1)] = decodeURIComponent(got);
    else if (want !== got) return null;
  }
  return params;
}

function findRoute(pathname: string): { entry: RouteEntry; params: Record<string, string> } | null {
  for (const entry of ROUTES) {
    const params = matchPattern(pathname, entry.pattern);
    if (params) return { entry, params };
  }
  return null;
}

/** IncomingMessage → 标准 Request；非 GET/HEAD 请求把请求体接成 half-duplex 流，边读边转发给处理函数 */
function toWebRequest(req: http.IncomingMessage, url: URL): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }

  const method = (req.method ?? "GET").toUpperCase();
  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    // IncomingMessage 本身就是 AsyncIterable<Buffer>，Node 的 fetch 实现（undici）接受它作为
    // 请求体；apps/web 的 tsconfig 加载了 dom lib，dom 自带的 RequestInit/BodyInit 类型比
    // undici 实际支持的窄（不认识异步可迭代对象、也没有 duplex 字段），这里按运行时的真实能力转一下类型
    init.body = req as unknown as BodyInit;
    init.duplex = "half";
  }
  return new Request(url, init);
}

/** Response → node:http 的响应：逐个头写回（Set-Cookie 可能有多条），响应体按流转发 */
async function sendWebResponse(res: http.ServerResponse, response: Response): Promise<void> {
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return;
    res.setHeader(key, value);
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) res.setHeader("set-cookie", cookies);
  res.statusCode = response.status;

  if (!response.body) {
    res.end();
    return;
  }
  await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), res);
}

/** IncomingHttpHeaders → 扁平的 Record<string,string>（小写 key），多值用逗号拼接；只给测试观察用 */
function flattenHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    result[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return result;
}

function sendPlainText(res: http.ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

async function dispatch(req: http.IncomingMessage, res: http.ServerResponse, baseUrl: string): Promise<void> {
  const url = new URL(req.url ?? "/", baseUrl);
  const match = findRoute(url.pathname);
  if (!match) {
    sendPlainText(res, 404, `测试服务端没有登记这个路由：${url.pathname}`);
    return;
  }

  const method = (req.method ?? "GET").toUpperCase() as HttpMethod;
  const handler = match.entry.handlers[method];
  if (!handler) {
    sendPlainText(res, 405, `${url.pathname} 不支持 ${method}`);
    return;
  }

  const request = toWebRequest(req, url);
  const response = await handler(request, { params: Promise.resolve(match.params) });
  await sendWebResponse(res, response);
}

export interface TestServer {
  /** 例如 http://127.0.0.1:54321，不带末尾斜杠 */
  url: string;
  /** M2 的测试夹具：服务容器、Store、直接建机器、签会话 cookie 等 */
  api: TestApi;
  /** 直接调用配对注册表签发一个配对码，不必走会话路由 */
  issuePairingCode(): { code: string; expiresAt: string };
  /** 路由表当前登记的全部 URL 写法，供 test-server.test.ts 与磁盘比对 */
  routePatterns(): string[];
  /**
   * 最近一次收到的请求的请求头（小写 key）；没有收到过请求时是 undefined。
   * 供端到端测试观察自定义头（比如 X-KH-Agent）是否真的送达了服务端。
   */
  lastRequestHeaders(): Record<string, string> | undefined;
  /** 关掉 HTTP 服务器并清理 M2 测试夹具（store、临时数据目录） */
  close(): Promise<void>;
}

export async function startTestServer(): Promise<TestServer> {
  const api = await setupTestApi();
  let lastHeaders: Record<string, string> | undefined;

  const server = http.createServer((req, res) => {
    lastHeaders = flattenHeaders(req.headers);
    const baseUrl = `http://${req.headers.host ?? "127.0.0.1"}`;
    dispatch(req, res, baseUrl).catch((err: unknown) => {
      // 测试夹具内部异常，直接打到测试输出方便定位
      console.error("[kh-test-server]", err);
      if (!res.headersSent) sendPlainText(res, 500, "测试服务端内部错误");
      else res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    api,

    issuePairingCode(): { code: string; expiresAt: string } {
      const admin = api.store.auth.listUsers().find((u) => u.role === "admin");
      if (!admin) throw new Error("测试夹具异常：管理员账号还没同步出来");
      return api.services.pairing.issue(admin.id);
    },

    routePatterns(): string[] {
      return ROUTES.map((r) => r.pattern);
    },

    lastRequestHeaders(): Record<string, string> | undefined {
      return lastHeaders;
    },

    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      await api.cleanup();
    },
  };
}
