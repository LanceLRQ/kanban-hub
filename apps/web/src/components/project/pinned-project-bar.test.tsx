// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import common from "../../../messages/zh-CN/common.json";
import enums from "../../../messages/zh-CN/enums.json";
import { PinnedProjectBar } from "./pinned-project-bar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * IntersectionObserver 替身：记下组件注册的回调，测试里手动喂一条 entry 模拟滚动位置。
 * jsdom 没有实现 IntersectionObserver，组件又只用到 observe / disconnect 两个方法。
 */
const observe = vi.fn();
const disconnect = vi.fn();
let fireEntry: ((entry: Partial<IntersectionObserverEntry>) => void) | null = null;
vi.stubGlobal(
  "IntersectionObserver",
  class {
    constructor(callback: (entries: IntersectionObserverEntry[]) => void) {
      fireEntry = (entry) => act(() => callback([entry as IntersectionObserverEntry]));
    }
    observe = observe;
    disconnect = disconnect;
    unobserve = vi.fn();
  },
);

/** 卡片整个滚出视口上沿（bottom 已是负数） */
const scrollPastCard = () => fireEntry?.({ isIntersecting: false, boundingClientRect: rect(-8) });
/** 卡片重新露头 */
const scrollBackToCard = () => fireEntry?.({ isIntersecting: true, boundingClientRect: rect(120) });
/** 组件只读 bottom，其余字段给 0 凑齐 DOMRectReadOnly 的形状 */
const rect = (bottom: number): DOMRectReadOnly => ({ bottom }) as DOMRectReadOnly;

let container: HTMLDivElement;
let root: Root;

function mount() {
  act(() => {
    root.render(
      <NextIntlClientProvider locale="zh-CN" messages={{ common, enums }}>
        <PinnedProjectBar project={{ name: "示例项目", cycle: "iteration", health: "on_track" }}>
          <section>头部卡片</section>
        </PinnedProjectBar>
      </NextIntlClientProvider>,
    );
  });
}

const bar = () => document.querySelector<HTMLElement>(".kh-pinned-project-bar")!;
const cssVar = () => document.documentElement.style.getPropertyValue("--kh-pinned-bar-h");
/** jsdom 里 offsetHeight 恒为 0，测高度写变量前先把顶栏量成 48px */
const fakeBarHeight = () => Object.defineProperty(bar(), "offsetHeight", { value: 48 });

beforeEach(() => {
  observe.mockClear();
  disconnect.mockClear();
  fireEntry = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.documentElement.style.removeProperty("--kh-pinned-bar-h");
});

describe("PinnedProjectBar 悬浮顶栏", () => {
  it("内容是一行核心信息：返回链接、项目名、周期、健康度", () => {
    mount();
    const text = bar().textContent ?? "";
    expect(text).toContain("返回项目列表");
    expect(text).toContain("示例项目");
    expect(text).toContain("迭代期");
    expect(text).toContain("正常");
    expect(bar().querySelector('a[href="/projects"]')).not.toBeNull();
  });

  it("卡片在视口内时隐藏，高度变量为 0", () => {
    mount();
    expect(bar().getAttribute("aria-hidden")).toBe("true");
    expect(bar().className).toContain("opacity-0");
    expect(cssVar()).toBe("0px");
  });

  it("卡片滚出视口上沿后出现，并把顶栏高度写给让位变量", () => {
    mount();
    fakeBarHeight();
    scrollPastCard();
    expect(bar().getAttribute("aria-hidden")).toBeNull();
    expect(bar().className).toContain("translate-y-0");
    expect(bar().className).not.toContain("pointer-events-none");
    expect(cssVar()).toBe("48px");
  });

  it("向上滚、卡片重新露头就收起，变量归零", () => {
    mount();
    fakeBarHeight();
    scrollPastCard();
    scrollBackToCard();
    expect(bar().getAttribute("aria-hidden")).toBe("true");
    expect(cssVar()).toBe("0px");
  });

  it("卡片在视口下方（没滚过头部的初始加载态）不出现", () => {
    mount();
    fireEntry?.({ isIntersecting: false, boundingClientRect: rect(400) });
    expect(bar().getAttribute("aria-hidden")).toBe("true");
  });

  it("观察的是包住头部卡片的哨兵元素，卸载时断开并清掉变量", () => {
    mount();
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledWith(container.firstElementChild);
    expect(disconnect).not.toHaveBeenCalled();
    act(() => root.unmount());
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(cssVar()).toBe("");
  });
});
