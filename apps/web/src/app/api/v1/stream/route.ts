import { KH_VERSION } from "@kanban-hub/core/version";
import { apiRoute } from "@/server/api/route";
import { authenticate } from "@/server/auth/authenticate";
import type { StoreChange } from "@/server/store/store";

// SSE 连接要一直开着，不能在构建期被静态化
export const dynamic = "force-dynamic";

/** 心跳间隔：顺带用来重新校验会话是否还有效（规格：每 15 秒一次） */
const HEARTBEAT_INTERVAL_MS = 15_000;

export const GET = apiRoute({ auth: "session" }, ({ req, services }) => {
  const encoder = new TextEncoder();
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;

  // 三条路径都会走到这里：请求中止（req.signal）、流被取消（cancel）、心跳时发现会话失效。
  // closed 保证只清理一次，重复调用（例如先中止又被取消）是安全的
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
    unsubscribe?.();
    req.signal.removeEventListener("abort", cleanup);
  };

  const enqueue = (chunk: string): void => {
    if (closed || !controllerRef) return;
    try {
      controllerRef.enqueue(encoder.encode(chunk));
    } catch {
      // 控制器已经关闭（例如客户端恰好在这一刻断开），跟着清理，不再往下写
      cleanup();
    }
  };

  const closeController = (): void => {
    try {
      controllerRef?.close();
    } catch {
      // 已经关闭，忽略
    }
  };

  /**
   * 每次心跳都重新鉴权，任何异常（不只是"会话失效"）都按会话失效处理：清理并关闭流。
   * 这里必须兜住所有异常——heartbeat() 是从 setInterval 回调里 `void` 掉的，一旦有一次
   * 意外抛错（哪怕是存储层没预料到的 bug），就会变成未处理的 rejection，Node 默认会把
   * 整个进程杀掉；每条打开的连接每 15 秒都有一次机会触发，风险会被连接数放大。
   */
  const heartbeat = async (): Promise<void> => {
    try {
      const principal = await authenticate(req, { auth: services.store.auth, now: services.now, seen: services.seen });
      if (closed) return; // 校验期间流可能已经因为中止或取消而关闭，不再继续
      if (!principal || principal.kind !== "session") {
        cleanup();
        closeController();
        return;
      }
      enqueue(": heartbeat\n\n");
    } catch (e) {
      // 错误信息里不能带 cookie 值：只记异常本身的 message，不回显请求头
      services.log(`SSE 心跳重新鉴权出错，按会话失效处理并关闭连接：${e instanceof Error ? e.message : String(e)}`);
      cleanup();
      closeController();
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      req.signal.addEventListener("abort", cleanup);

      enqueue("retry: 3000\n");
      enqueue(`event: ready\ndata: ${JSON.stringify({ version: KH_VERSION })}\n\n`);

      unsubscribe = services.store.subscribe((change: StoreChange) => {
        // change 里的事件可能不全：写入时事件追加失败也照常通知（M1 的语义，修改本身已经生效）。
        // 网页收到通知后应该整个重新拉取这个项目，不要依赖这里的事件内容做增量更新（交给 M4）
        enqueue(`event: change\ndata: ${JSON.stringify({ projectId: change.projectId, events: change.events })}\n\n`);
      });

      heartbeatTimer = setInterval(() => {
        void heartbeat();
      }, HEARTBEAT_INTERVAL_MS);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
});
