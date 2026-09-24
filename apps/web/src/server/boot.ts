import { syncAdminPassword } from "./auth/admin";
import { LastSeenTracker } from "./auth/authenticate";
import { PairingRegistry } from "./auth/pairing";
import { FailureLimiter } from "./auth/rate-limit";
import { resolveServerPaths } from "./paths";
import { enforceSelfCheck } from "./selfcheck";
import type { Services } from "./services";
import { setServices } from "./services";
import { installShutdown } from "./shutdown";
import { peekStore, setStore } from "./store/instance";
import { Store } from "./store/store";

/**
 * 服务启动：自检 → 打开存储 → 同步管理员密码 → 建服务容器（配对码、限流、lastSeenAt 节流）
 * → 挂到全局 → 接管关机信号。由 instrumentation 的 register() 在 Node 运行时调用；
 * 进程相关的 API（process.exit、process.env）都放在这个模块里。
 */
export async function boot(): Promise<void> {
  // 开发时热更新可能再次触发；store 和服务容器在最后一起挂上，避免中途重入时拿到半初始化的状态
  if (peekStore()) return;
  const paths = resolveServerPaths();
  await enforceSelfCheck(paths);
  const store = await openStoreOrExit(paths.dataDir);

  await syncAdminPasswordOrExit(store);
  const now = () => new Date();
  const log = (message: string) => console.log(`[kanban-hub] ${message}`);
  const services: Services = {
    store,
    pairing: new PairingRegistry({ now }),
    limiter: new FailureLimiter({ now }),
    seen: new LastSeenTracker({ now, log }),
    publicUrl: resolvePublicUrlOrExit(),
    now,
    log,
  };

  setStore(store);
  setServices(services);
  installShutdown({
    onSignal: (signal, handler) => {
      process.on(signal, handler);
    },
    close: async () => {
      if (!(await store.close())) console.warn("[kanban-hub] 部分改动没来得及提交，下次启动时会补提交");
    },
    exit: (code) => process.exit(code),
    log: (message) => console.log(`[kanban-hub] ${message}`),
    setTimer: (fn, ms) => setTimeout(fn, ms),
  });
  console.log(`[kanban-hub] 数据目录已就绪：${paths.dataDir}`);
}

async function openStoreOrExit(dataDir: string): Promise<Store> {
  try {
    return await Store.open({ dataDir });
  } catch (e) {
    // DataFileError 的消息里带有文件和行号（规格第 15 节）
    console.error(`[kanban-hub] 启动失败：${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

/** 自检已经确保 KH_ADMIN_PASSWORD 有值；这里再兜底一次，失败时和存储打开失败一样退出进程 */
async function syncAdminPasswordOrExit(store: Store): Promise<void> {
  const password = process.env.KH_ADMIN_PASSWORD;
  if (!password) {
    console.error("[kanban-hub] 启动失败：缺少环境变量 KH_ADMIN_PASSWORD");
    process.exit(1);
  }
  try {
    const result = await syncAdminPassword(store.auth, password);
    console.log(`[kanban-hub] 管理员账号已同步：${result}`);
  } catch (e) {
    console.error(`[kanban-hub] 启动失败：同步管理员账号时出错：${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

/** KH_PUBLIC_URL 没设置时返回 null；设置了但不是合法的 http/https 地址就拒绝启动 */
function resolvePublicUrlOrExit(): string | null {
  const raw = process.env.KH_PUBLIC_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("协议必须是 http 或 https");
    return raw;
  } catch (e) {
    console.error(
      `[kanban-hub] 启动失败：KH_PUBLIC_URL 不是合法的 http/https 地址（当前为“${raw}”）：${e instanceof Error ? e.message : String(e)}`,
    );
    process.exit(1);
  }
}
