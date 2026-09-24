import { afterEach, describe, expect, it, vi } from "vitest";
import type { KhError } from "@kanban-hub/core/errors";
import { getStore, peekStore, setStore } from "./instance";
import type { Store } from "./store";

afterEach(() => {
  setStore(undefined);
});

describe("存储单例", () => {
  it("还没设置时 peek 返回 undefined，get 报 unavailable", () => {
    expect(peekStore()).toBeUndefined();
    let err: unknown;
    try {
      getStore();
    } catch (e) {
      err = e;
    }
    expect((err as KhError).code).toBe("unavailable");
  });

  it("设置后 get 与 peek 返回同一个实例", () => {
    const fake = {} as Store;
    setStore(fake);
    expect(getStore()).toBe(fake);
    expect(peekStore()).toBe(fake);
  });

  it("换一份模块实例也能取到同一个存储（Next 会把各个路由编译成不同的模块实例）", async () => {
    const fake = {} as Store;
    setStore(fake);
    vi.resetModules();
    const fresh = await import("./instance");
    expect(fresh.peekStore()).toBe(fake);
  });
});
