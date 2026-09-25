/**
 * `LiveRefresh` 的连接状态判断，抽成不依赖 DOM/定时器的纯函数，方便单测。
 *
 * 页面隐藏超过 5 秒才暂停连接（`onHiddenTimeout`）：调用方用 `setTimeout(..., 5000)` 触发这个
 * 判断，隐藏不足 5 秒又变回可见时调用方会先清掉这个定时器，`onHiddenTimeout` 根本不会被调用，
 * 状态原地保持 `"connected"`。暂停期间的连接错误要被忽略，不进入重连退避；从暂停恢复时要
 * 重新连接并刷新一次，补上暂停期间错过的改动。
 */
export type LiveConnectionState = "connected" | "paused";

export interface LiveVisibilityDecision {
  state: LiveConnectionState;
  /** 需要关闭现有的 SSE 连接 */
  closeConnection: boolean;
  /** 需要重新发起连接 */
  reconnect: boolean;
  /** 重新连接后需要刷新一次数据 */
  refreshAfterReconnect: boolean;
}

/** 页面隐藏满 5 秒：暂停连接，不重连、不刷新 */
export function onHiddenTimeout(): LiveVisibilityDecision {
  return { state: "paused", closeConnection: true, reconnect: false, refreshAfterReconnect: false };
}

/** 页面变回可见：只有从暂停状态恢复时才需要重连并刷新一次；本来就连着时什么都不做 */
export function onVisible(state: LiveConnectionState): LiveVisibilityDecision {
  if (state === "paused") {
    return { state: "connected", closeConnection: false, reconnect: true, refreshAfterReconnect: true };
  }
  return { state: "connected", closeConnection: false, reconnect: false, refreshAfterReconnect: false };
}

/** 暂停期间的连接错误（EventSource.onerror）要直接忽略，不进入重连退避 */
export function shouldIgnoreConnectionError(state: LiveConnectionState): boolean {
  return state === "paused";
}

/** 探活请求（`/api/v1/me`）返回 401 时，组件已经卸载（`stopped`）就不用再跳登录页了 */
export function shouldRedirectOnUnauthorized(stopped: boolean): boolean {
  return !stopped;
}
