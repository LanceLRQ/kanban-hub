import { describe, expect, it } from "vitest";
import { onHiddenTimeout, onVisible, shouldIgnoreConnectionError, shouldRedirectOnUnauthorized } from "./live-machine";

describe("live-machine", () => {
  it("隐藏不足 5 秒又回来：定时器被清掉，onHiddenTimeout 不会被调用，状态原地保持 connected，不重连不刷新", () => {
    const decision = onVisible("connected");
    expect(decision).toEqual({ state: "connected", closeConnection: false, reconnect: false, refreshAfterReconnect: false });
  });

  it("隐藏超过 5 秒后回来：先暂停，再从暂停恢复时重连并刷新一次", () => {
    const paused = onHiddenTimeout();
    expect(paused).toEqual({ state: "paused", closeConnection: true, reconnect: false, refreshAfterReconnect: false });

    const resumed = onVisible(paused.state);
    expect(resumed).toEqual({ state: "connected", closeConnection: false, reconnect: true, refreshAfterReconnect: true });
  });

  it("暂停期间收到连接错误要忽略；正常连接期间的错误不能忽略", () => {
    expect(shouldIgnoreConnectionError("paused")).toBe(true);
    expect(shouldIgnoreConnectionError("connected")).toBe(false);
  });

  it("401 跳转前要检查组件是否已经卸载（stopped）", () => {
    expect(shouldRedirectOnUnauthorized(false)).toBe(true);
    expect(shouldRedirectOnUnauthorized(true)).toBe(false);
  });
});
