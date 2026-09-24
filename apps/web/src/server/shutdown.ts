export type ShutdownSignal = "SIGTERM" | "SIGINT";

export interface ShutdownDeps {
  onSignal: (signal: ShutdownSignal, handler: () => void) => void;
  /** 停止接收写入，等写入队列跑完，提交未提交的改动 */
  close: () => Promise<void>;
  exit: (code: number) => void;
  log: (message: string) => void;
  setTimer: (fn: () => void, ms: number) => { unref(): void };
  graceMs?: number;
}

/** 关机宽限期：docker stop 默认 10 秒后发 SIGKILL，这里留出余量 */
export const SHUTDOWN_GRACE_MS = 8_000;

/**
 * 接管关机信号。生产镜像设置了 NEXT_MANUAL_SIG_HANDLE=1，Next 不再注册自己的处理
 * （否则它会等所有连接关闭才退出，SSE 长连接会让关机一直卡到 SIGKILL），关机完全由这里负责：
 * 先保存数据再退出；超过宽限期仍未完成就直接退出，没提交的改动在下次启动时补提交（规格 6.5）。
 * next dev 的父进程转发信号后默认只等 100 毫秒（NEXT_EXIT_TIMEOUT_MS）就强杀子进程，开发时同样依靠启动补提交。
 */
export function installShutdown(deps: ShutdownDeps): void {
  let stopping = false;
  const handle = (signal: ShutdownSignal) => {
    if (stopping) {
      deps.log(`再次收到 ${signal}，立即退出`);
      deps.exit(1);
      return;
    }
    stopping = true;
    deps.log(`收到 ${signal}，正在保存数据后退出`);
    deps
      .setTimer(() => {
        deps.log("关机超时，未提交的改动会在下次启动时补提交");
        deps.exit(1);
      }, deps.graceMs ?? SHUTDOWN_GRACE_MS)
      .unref();
    deps.close().then(
      () => deps.exit(0),
      (e: unknown) => {
        deps.log(`关机时出错：${e instanceof Error ? e.message : String(e)}`);
        deps.exit(1);
      },
    );
  };
  deps.onSignal("SIGTERM", () => handle("SIGTERM"));
  deps.onSignal("SIGINT", () => handle("SIGINT"));
}
