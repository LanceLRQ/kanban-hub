import { resolveServerPaths } from "./paths";
import { enforceSelfCheck } from "./selfcheck";
import { installShutdown } from "./shutdown";
import { peekStore, setStore } from "./store/instance";
import { Store } from "./store/store";

/**
 * 服务启动：自检 → 打开存储并挂到全局 → 接管关机信号。
 * 由 instrumentation 的 register() 在 Node 运行时调用；进程相关的 API 都放在这里。
 */
export async function boot(): Promise<void> {
  // 开发时热更新可能再次触发，已经打开过就不重复
  if (peekStore()) return;
  const paths = resolveServerPaths();
  await enforceSelfCheck(paths);
  const store = await openStoreOrExit(paths.dataDir);
  setStore(store);
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
