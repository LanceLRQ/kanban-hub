import { afterEach, describe, expect, it, vi } from "vitest";
import type { KhError } from "@kanban-hub/core/errors";
import { getServices, peekServices, setServices, type Services } from "./services";

function fakeServices(): Services {
  return {
    store: {} as Services["store"],
    pairing: {} as Services["pairing"],
    limiter: {} as Services["limiter"],
    seen: {} as Services["seen"],
    publicUrl: null,
    staleDays: 7,
    now: () => new Date(),
    log: () => {},
  };
}

afterEach(() => {
  setServices(undefined);
});

describe("服务容器", () => {
  it("还没设置时 peek 返回 undefined，get 报 unavailable", () => {
    expect(peekServices()).toBeUndefined();
    let err: unknown;
    try {
      getServices();
    } catch (e) {
      err = e;
    }
    expect((err as KhError).code).toBe("unavailable");
  });

  it("设置后 get 与 peek 返回同一个实例", () => {
    const services = fakeServices();
    setServices(services);
    expect(getServices()).toBe(services);
    expect(peekServices()).toBe(services);
  });

  it("换一份模块实例也能取到同一个服务容器（Next 会把各个路由编译成不同的模块实例）", async () => {
    const services = fakeServices();
    setServices(services);
    vi.resetModules();
    const fresh = await import("./services");
    expect(fresh.peekServices()).toBe(services);
  });
});
