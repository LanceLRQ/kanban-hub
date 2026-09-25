"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { apiRequest, ApiRequestError } from "@/lib/client/api";
import { nextBackoffSeconds } from "@/lib/client/backoff";
import { sanitizeNextPath } from "@/lib/client/next-path";
import { setLiveStatus } from "./live-status-store";

const CHANGE_DEBOUNCE_MS = 300;

/**
 * 只在 (app) 布局里挂一次：维护一条到 `/api/v1/stream` 的 SSE 连接。
 * 收到 `change` 事件去抖 300ms 后 `router.refresh()`；连接断开后按 1、2、4、8…30 秒退避重连，
 * 重连前先探一次 `/api/v1/me`（401 说明会话已失效，直接跳登录，不再重试）；
 * 从断开恢复后刷新一次数据。不渲染任何内容。
 */
export function LiveRefresh(): null {
  const router = useRouter();

  useEffect(() => {
    let stopped = false;
    let source: EventSource | null = null;
    let changeTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let backoffSeconds = 0;
    let disconnectedOnce = false;

    function clearTimers(): void {
      if (changeTimer !== undefined) clearTimeout(changeTimer);
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    }

    function scheduleReconnect(): void {
      backoffSeconds = nextBackoffSeconds(backoffSeconds);
      reconnectTimer = setTimeout(() => void handleDisconnect(), backoffSeconds * 1000);
    }

    async function handleDisconnect(): Promise<void> {
      if (stopped) return;
      setLiveStatus("reconnecting");
      disconnectedOnce = true;

      try {
        await apiRequest("/api/v1/me");
      } catch (e) {
        if (e instanceof ApiRequestError && e.status === 401) {
          setLiveStatus("offline");
          const next = typeof window !== "undefined" ? sanitizeNextPath(window.location.pathname) : "/";
          router.push(`/login?next=${encodeURIComponent(next)}`);
          return;
        }
        // 网络错误等：会话状态未知，继续按退避重试，不主动跳登录
      }

      if (stopped) return;
      connect();
    }

    function connect(): void {
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
        source?.close();
        setLiveStatus("reconnecting");
        scheduleReconnect();
      };
    }

    connect();

    return () => {
      stopped = true;
      source?.close();
      clearTimers();
    };
  }, [router]);

  return null;
}
