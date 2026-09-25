"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { apiRequest, ApiRequestError } from "@/lib/client/api";
import { nextBackoffSeconds } from "@/lib/client/backoff";
import { onHiddenTimeout, onVisible, shouldIgnoreConnectionError, shouldRedirectOnUnauthorized, type LiveConnectionState } from "@/lib/client/live-machine";
import { sanitizeNextPath } from "@/lib/client/next-path";
import { setLiveStatus } from "./live-status-store";

const CHANGE_DEBOUNCE_MS = 300;
/** 页面隐藏满这么久才暂停连接：留出余量，避免快速切换标签页时反复断开重连 */
const HIDE_PAUSE_MS = 5000;

/**
 * 只在 (app) 布局里挂一次：维护一条到 `/api/v1/stream` 的 SSE 连接。
 * 收到 `change` 事件去抖 300ms 后 `router.refresh()`；连接断开后按 1、2、4、8…30 秒退避重连，
 * 重连前先探一次 `/api/v1/me`（401 说明会话已失效，直接跳登录，不再重试）；
 * 从断开恢复后刷新一次数据。
 *
 * 页面隐藏满 5 秒后暂停连接（`pagehide` 立即暂停），可见时重新连接并刷新一次：浏览器对同一
 * 主机的并发连接数有限（HTTP/1.1 下通常是 6 条），隐藏的标签页一直占着连接会导致其他标签页
 * 排队卡住，具体判断逻辑见 `lib/client/live-machine.ts`。不渲染任何内容。
 */
export function LiveRefresh(): null {
  const router = useRouter();

  useEffect(() => {
    let stopped = false;
    let source: EventSource | null = null;
    let changeTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    let backoffSeconds = 0;
    let disconnectedOnce = false;
    let connectionState: LiveConnectionState = "connected";

    function clearTimers(): void {
      if (changeTimer !== undefined) clearTimeout(changeTimer);
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      if (hideTimer !== undefined) clearTimeout(hideTimer);
    }

    function scheduleReconnect(): void {
      backoffSeconds = nextBackoffSeconds(backoffSeconds);
      reconnectTimer = setTimeout(() => void handleDisconnect(), backoffSeconds * 1000);
    }

    function pause(): void {
      const decision = onHiddenTimeout();
      connectionState = decision.state;
      if (decision.closeConnection) source?.close();
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      if (changeTimer !== undefined) clearTimeout(changeTimer);
      // 不改动 liveStatus：暂停是主动行为，不是断线，顶栏不应该显示“已断开”
    }

    function resume(): void {
      const decision = onVisible(connectionState);
      connectionState = decision.state;
      if (!decision.reconnect) return;
      backoffSeconds = 0;
      disconnectedOnce = decision.refreshAfterReconnect;
      connect();
    }

    async function handleDisconnect(): Promise<void> {
      if (stopped) return;
      setLiveStatus("reconnecting");
      disconnectedOnce = true;

      try {
        await apiRequest("/api/v1/me");
      } catch (e) {
        if (e instanceof ApiRequestError && e.status === 401) {
          if (!shouldRedirectOnUnauthorized(stopped)) return;
          setLiveStatus("offline");
          const next = typeof window !== "undefined" ? sanitizeNextPath(window.location.pathname + window.location.search) : "/";
          router.push(`/login?next=${encodeURIComponent(next)}`);
          return;
        }
        // 网络错误等：会话状态未知，继续按退避重试，不主动跳登录
      }

      // 探活期间页面可能已经暂停：此时不再连接，等变回可见时由 resume() 重连
      if (stopped || shouldIgnoreConnectionError(connectionState)) return;
      connect();
    }

    function connect(): void {
      // 同一时刻只保留一条连接：重连前先关掉可能还开着的旧连接
      source?.close();
      source = new EventSource("/api/v1/stream");

      source.addEventListener("ready", () => {
        backoffSeconds = 0;
        setLiveStatus("connected");
        if (disconnectedOnce) {
          disconnectedOnce = false;
          router.refresh();
        }
      });

      source.addEventListener("change", () => {
        if (changeTimer !== undefined) clearTimeout(changeTimer);
        changeTimer = setTimeout(() => router.refresh(), CHANGE_DEBOUNCE_MS);
      });

      source.onerror = () => {
        if (stopped) return;
        if (shouldIgnoreConnectionError(connectionState)) return;
        source?.close();
        setLiveStatus("reconnecting");
        scheduleReconnect();
      };
    }

    function handleVisibilityChange(): void {
      if (document.visibilityState === "hidden") {
        hideTimer = setTimeout(pause, HIDE_PAUSE_MS);
        return;
      }
      if (hideTimer !== undefined) {
        clearTimeout(hideTimer);
        hideTimer = undefined;
      }
      resume();
    }

    function handlePageHide(): void {
      if (hideTimer !== undefined) {
        clearTimeout(hideTimer);
        hideTimer = undefined;
      }
      pause();
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", handlePageHide);

    connect();

    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", handlePageHide);
      source?.close();
      clearTimers();
    };
  }, [router]);

  return null;
}
