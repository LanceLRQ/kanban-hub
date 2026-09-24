import { KhError } from "@kanban-hub/core/errors";
import type { LastSeenTracker } from "./auth/authenticate";
import type { PairingRegistry } from "./auth/pairing";
import type { FailureLimiter } from "./auth/rate-limit";
import type { Store } from "./store/store";

/**
 * 进程内共享的服务容器：存储加上 M2 新增的内存状态（配对码、限流、lastSeenAt 节流）。
 * 与 store/instance.ts 的单例一样挂在 globalThis 上——Next 把每个路由编译成独立的模块实例，
 * 模块级变量互不相通，只有 globalThis 上的引用能在它们之间共享。
 */
export interface Services {
  store: Store;
  pairing: PairingRegistry;
  limiter: FailureLimiter;
  seen: LastSeenTracker;
  /** KH_PUBLIC_URL 校验通过后的值；没设置时为 null */
  publicUrl: string | null;
  now: () => Date;
  log: (message: string) => void;
}

const holder = globalThis as typeof globalThis & { __kanbanHubServices?: Services };

export function setServices(services: Services | undefined): void {
  holder.__kanbanHubServices = services;
}

export function peekServices(): Services | undefined {
  return holder.__kanbanHubServices;
}

/** 取服务容器；启动还没完成时抛出 unavailable（API 外壳映射为 503） */
export function getServices(): Services {
  const services = peekServices();
  if (!services) throw new KhError("unavailable", "服务还在启动，请稍后重试");
  return services;
}
