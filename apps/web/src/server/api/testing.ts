import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_STALE_DAYS } from "@kanban-hub/core/derive";
import type { Machine, User } from "@kanban-hub/core/schema";
import { LastSeenTracker } from "../auth/authenticate";
import { syncAdminPassword } from "../auth/admin";
import { PairingRegistry } from "../auth/pairing";
import { FailureLimiter } from "../auth/rate-limit";
import { SESSION_COOKIE, SESSION_TTL_MS, signSession } from "../auth/session";
import { generateMachineToken, hashToken } from "../auth/token";
import { setServices, type Services } from "../services";
import { Store } from "../store/store";

/**
 * M2 路由测试用的夹具：打开一个真实的临时 Store（真实 git，提交去抖设得足够长，
 * 测试期间不会触发中间提交）、同步出一个低成本 scrypt 的管理员账号，把服务容器挂到
 * globalThis 供 apiRoute 外壳使用。每个测试用例都应该 `await setupTestApi()`，
 * 用完调用返回值的 `cleanup()`（放在 afterEach 里），互不影响。
 */
export interface TestApi {
  /** 挂到 globalThis 上的服务容器，即 apiRoute 外壳会拿到的那一份 */
  services: Services;
  /** 服务容器里的同一个 Store，方便测试直接读写数据做前置准备 */
  store: Store;
  /** 同步管理员账号时用的明文密码，用于测试 /auth/login */
  adminPassword: string;

  /** 签一个当前管理员的有效会话 cookie，形如 `kh_session=<值>`，可以直接放进 Cookie 请求头 */
  sessionCookie(): string;

  /**
   * 直接用 store.auth.createMachine 建一台属于管理员的机器（不经过 /pair 路由），
   * 返回配对得到的令牌明文和机器记录。
   */
  pairMachine(name?: string): Promise<{ token: string; machine: Machine }>;

  /**
   * 构造一个可以直接传给 apiRoute 外壳的请求。`path` 相对 http://localhost 解析。
   * - `cookie`：整段 Cookie 请求头的值（通常就是 sessionCookie() 的返回值）；
   * - `token`：机器令牌明文，会包成 `Authorization: Bearer <token>`；
   * - `origin`：省略时默认给出与请求同源的 Origin（http://localhost），传 `null` 表示不带这个头
   *   （用于测试缺少 Origin 的场景），传字符串则原样使用（用于测试跨域）；
   * - `json`：会序列化成请求体并加上 `content-type: application/json`。
   */
  request(path: string, opts?: TestRequestOptions): Request;

  /** 生成路由处理函数的第二个参数（ctx），params 会被包成 Promise，和 Next 的约定一致 */
  ctx<P extends Record<string, unknown>>(params: P): { params: Promise<P> };

  /** 卸下服务容器、关闭 Store、删除临时数据目录 */
  cleanup(): Promise<void>;
}

export interface TestRequestOptions {
  method?: string;
  json?: unknown;
  cookie?: string | null;
  token?: string | null;
  origin?: string | null;
  headers?: Record<string, string>;
}

/** 测试用的低成本 scrypt 参数，避免每个用例都跑一遍默认成本 */
const TEST_SCRYPT_PARAMS = { N: 16, r: 1, p: 1 };
const DEFAULT_BASE_URL = "http://localhost";

export async function setupTestApi(): Promise<TestApi> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "kh-api-test-"));
  const now = () => new Date();
  const log = () => {};

  // 去抖设得比任何一个测试用例都长，保证测试期间不会有中间提交；close() 时仍会补提交一次
  const store = await Store.open({ dataDir, now, commitDebounceMs: 60_000, log });

  const adminPassword = "test-admin-password";
  await syncAdminPassword(store.auth, adminPassword, TEST_SCRYPT_PARAMS);

  const services: Services = {
    store,
    pairing: new PairingRegistry({ now }),
    limiter: new FailureLimiter({ now }),
    seen: new LastSeenTracker({ now, log }),
    publicUrl: null,
    staleDays: DEFAULT_STALE_DAYS,
    now,
    log,
  };
  setServices(services);

  function adminUser(): User {
    const admin = store.auth.listUsers().find((u) => u.role === "admin");
    if (!admin) throw new Error("测试夹具异常：管理员账号还没同步出来");
    return admin;
  }

  return {
    services,
    store,
    adminPassword,

    sessionCookie(): string {
      const admin = adminUser();
      const value = signSession(
        { userId: admin.id, sessionVersion: admin.sessionVersion, expiresAt: now().getTime() + SESSION_TTL_MS },
        store.auth.sessionSecret(),
      );
      return `${SESSION_COOKIE}=${value}`;
    },

    async pairMachine(name = "测试机器"): Promise<{ token: string; machine: Machine }> {
      const token = generateMachineToken();
      const machine = await store.auth.createMachine({
        name,
        userId: adminUser().id,
        os: "darwin",
        tokenHash: hashToken(token),
      });
      return { token, machine };
    },

    request(requestPath: string, opts: TestRequestOptions = {}): Request {
      return buildRequest(requestPath, opts);
    },

    ctx<P extends Record<string, unknown>>(params: P): { params: Promise<P> } {
      return { params: Promise.resolve(params) };
    },

    async cleanup(): Promise<void> {
      setServices(undefined);
      await store.close();
      await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
}

function buildRequest(requestPath: string, opts: TestRequestOptions): Request {
  const url = new URL(requestPath, DEFAULT_BASE_URL);
  const headers = new Headers(opts.headers);

  if (opts.cookie) headers.set("cookie", opts.cookie);
  if (opts.token) headers.set("authorization", `Bearer ${opts.token}`);
  // origin 显式传 null 时不带这个头，用于测试缺少 Origin 的场景；省略时默认给出同源的值
  if (opts.origin !== null) headers.set("origin", opts.origin ?? DEFAULT_BASE_URL);
  if (!headers.has("host")) headers.set("host", url.host);

  const init: RequestInit = { method: opts.method ?? "GET", headers };
  if (opts.json !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(opts.json);
  }
  return new Request(url, init);
}
