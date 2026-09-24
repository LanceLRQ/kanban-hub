import { KhError } from "@kanban-hub/core/errors";
import type { Store } from "./store";

// Next 会把 instrumentation 和各个路由编译成不同的模块实例，模块级变量互不相通；
// 挂在 globalThis 上，路由拿到的才是 register() 创建的那一个
const holder = globalThis as typeof globalThis & { __kanbanHubStore?: Store };

export function setStore(store: Store | undefined): void {
  holder.__kanbanHubStore = store;
}

export function peekStore(): Store | undefined {
  return holder.__kanbanHubStore;
}

/** 取存储实例；启动还没完成时抛出 unavailable（M2 映射为 503） */
export function getStore(): Store {
  const store = peekStore();
  if (!store) throw new KhError("unavailable", "服务还在启动，请稍后重试");
  return store;
}
