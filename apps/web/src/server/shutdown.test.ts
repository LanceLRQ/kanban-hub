import { describe, expect, it } from "vitest";
import { SHUTDOWN_GRACE_MS, type ShutdownSignal, installShutdown } from "./shutdown";

function harness(close: () => Promise<void> = async () => {}) {
  const handlers = new Map<ShutdownSignal, () => void>();
  const timers: { fn: () => void; ms: number; unref: boolean }[] = [];
  const exits: number[] = [];
  const logs: string[] = [];
  installShutdown({
    onSignal: (signal, handler) => handlers.set(signal, handler),
    close,
    exit: (code) => exits.push(code),
    log: (message) => logs.push(message),
    setTimer: (fn, ms) => {
      const timer = { fn, ms, unref: false };
      timers.push(timer);
      return {
        unref: () => {
          timer.unref = true;
        },
      };
    },
  });
  return { handlers, timers, exits, logs };
}

const nextTick = () => new Promise((resolve) => setImmediate(resolve));

describe("installShutdown", () => {
  it("注册 SIGTERM 与 SIGINT", () => {
    expect([...harness().handlers.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);
  });

  it("收到信号后先关闭存储，再以 0 退出", async () => {
    let closed = false;
    const h = harness(async () => {
      closed = true;
    });
    h.handlers.get("SIGTERM")!();
    await nextTick();
    expect(closed).toBe(true);
    expect(h.exits).toEqual([0]);
    expect(h.logs[0]).toContain("SIGTERM");
  });

  it("装一个不阻止进程退出的兜底定时器，超时后以 1 退出", () => {
    const h = harness(() => new Promise(() => {}));
    h.handlers.get("SIGINT")!();
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]).toMatchObject({ ms: SHUTDOWN_GRACE_MS, unref: true });
    h.timers[0]!.fn();
    expect(h.exits).toEqual([1]);
  });

  it("关闭出错时以 1 退出，并记下原因", async () => {
    const h = harness(async () => {
      throw new Error("磁盘已满");
    });
    h.handlers.get("SIGTERM")!();
    await nextTick();
    expect(h.exits).toEqual([1]);
    expect(h.logs.join("\n")).toContain("磁盘已满");
  });

  it("关机过程中再次收到信号就立即退出", () => {
    const h = harness(() => new Promise(() => {}));
    h.handlers.get("SIGTERM")!();
    h.handlers.get("SIGINT")!();
    expect(h.exits).toEqual([1]);
  });
});
