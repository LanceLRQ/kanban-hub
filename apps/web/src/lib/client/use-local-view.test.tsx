// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { z } from "zod";
import { resetLocalViewStoreForTest, useLocalView } from "./use-local-view";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = "kh-test-view";
const schema = z.object({ sort: z.enum(["manual", "name"]), hide: z.boolean() });
type View = z.infer<typeof schema>;
const defaults: View = { sort: "manual", hide: false };

interface Seen {
  value: View;
  set: (v: View) => void;
  reset: () => void;
  renders: number;
}
const seen = new Map<string, Seen>();
const record = (id: string, value: View, set: Seen["set"], reset: Seen["reset"]) =>
  seen.set(id, { value, set, reset, renders: (seen.get(id)?.renders ?? 0) + 1 });
const latest = (id: string): Seen => {
  const s = seen.get(id);
  if (!s) throw new Error(`probe ${id} 没有渲染`);
  return s;
};

function Probe({ id, storageKey = KEY }: { id: string; storageKey?: string }) {
  const [value, set, reset] = useLocalView(storageKey, schema, defaults);
  record(id, value, set, reset);
  return <span data-id={id}>{JSON.stringify(value)}</span>;
}

let container: HTMLDivElement;
let root: Root;

function mount(ids: string[] = ["a"]) {
  act(() => {
    root.render(ids.map((id) => <Probe key={id} id={id} />));
  });
}

beforeEach(() => {
  seen.clear();
  window.localStorage.clear();
  resetLocalViewStoreForTest();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("useLocalView", () => {
  it("服务端渲染返回默认值，即使 localStorage 里有值", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ sort: "name", hide: true }));
    expect(renderToStaticMarkup(<Probe id="ssr" />)).toContain(JSON.stringify(defaults).replaceAll('"', "&quot;"));
  });

  it("没有保存值时返回默认值，挂载后读到已保存的值", () => {
    mount();
    expect(latest("a").value).toEqual(defaults);
    act(() => root.unmount());
    window.localStorage.setItem(KEY, JSON.stringify({ sort: "name", hide: true }));
    resetLocalViewStoreForTest();
    root = createRoot(container);
    mount();
    expect(latest("a").value).toEqual({ sort: "name", hide: true });
  });

  it("坏 JSON 和不合 schema 的值都回退到默认值", () => {
    window.localStorage.setItem(KEY, "{oops");
    mount();
    expect(latest("a").value).toEqual(defaults);
    act(() => root.unmount());
    window.localStorage.setItem(KEY, JSON.stringify({ sort: "bogus", hide: 1 }));
    root = createRoot(container);
    mount();
    expect(latest("a").value).toEqual(defaults);
  });

  it("set 持久化，并同步到同一个键的另一个实例；快照稳定不会反复渲染", () => {
    mount(["a", "b"]);
    act(() => latest("a").set({ sort: "name", hide: true }));
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toEqual({ sort: "name", hide: true });
    expect(latest("a").value).toEqual({ sort: "name", hide: true });
    expect(latest("b").value).toEqual({ sort: "name", hide: true });
    expect(latest("b").renders).toBeLessThan(5);
  });

  it("其他标签页触发 storage 事件后，值随之更新", () => {
    mount();
    window.localStorage.setItem(KEY, JSON.stringify({ sort: "name", hide: false }));
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
    });
    expect(latest("a").value).toEqual({ sort: "name", hide: false });
  });

  it("reset 删除该键，值回到默认", () => {
    mount();
    act(() => latest("a").set({ sort: "name", hide: true }));
    act(() => latest("a").reset());
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(latest("a").value).toEqual(defaults);
  });

  it("读取 localStorage 抛异常时回退默认值，不崩溃", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    mount();
    expect(latest("a").value).toEqual(defaults);
  });

  it("写入 localStorage 抛异常时退回内存保存，reset 后恢复默认", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    mount(["a", "b"]);
    act(() => latest("a").set({ sort: "name", hide: true }));
    expect(latest("a").value).toEqual({ sort: "name", hide: true });
    expect(latest("b").value).toEqual({ sort: "name", hide: true });
    act(() => latest("a").reset());
    expect(latest("a").value).toEqual(defaults);
  });
});
