"use client";

import { useSyncExternalStore } from "react";
import { getLiveStatus, subscribeLiveStatus, type LiveStatus } from "./live-status-store";

/** 顶栏用来显示断线标记：`"connected" | "reconnecting" | "offline"` */
export function useLiveStatus(): LiveStatus {
  return useSyncExternalStore(subscribeLiveStatus, getLiveStatus, () => "connected");
}
