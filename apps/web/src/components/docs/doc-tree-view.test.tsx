// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import docs from "../../../messages/zh-CN/docs.json";
import { buildDocTree } from "@/lib/doc-tree";
import { resetLocalViewStoreForTest } from "@/lib/client/use-local-view";
import { DocTreeView } from "./doc-tree-view";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = "kh-doc-tree:p1";
const nodes = buildDocTree(["README.md", "docs/guide/intro.md", "docs/guide/Setup.md", "docs/api.md", "src/lib/a.ts"]);

let container: HTMLDivElement;
let root: Root;

function mount(currentPath: string | null = "docs/guide/intro.md", machineId: string | null = "m1") {
  act(() => {
    root.render(
      <NextIntlClientProvider locale="zh-CN" messages={{ docs }}>
        <DocTreeView projectId="p1" machineId={machineId ?? undefined} nodes={nodes} currentPath={currentPath} />
      </NextIntlClientProvider>,
    );
  });
}

const click = (el: Element) => act(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const fileNames = () => [...container.querySelectorAll("a")].map((a) => a.textContent ?? "");
const dirButton = (name: string) => [...container.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find((b) => (b.textContent ?? "").includes(name))!;
const byLabel = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const search = () => container.querySelector<HTMLInputElement>('input[type="text"], input:not([type])')!;
const type = (value: string) => {
  const input = search();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const stored = () => JSON.parse(window.localStorage.getItem(KEY) ?? "null") as string[] | null;

beforeEach(() => {
  window.localStorage.clear();
  resetLocalViewStoreForTest();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("DocTreeView 折叠", () => {
  it("默认只展开当前文件所在的目录链", () => {
    mount();
    expect(fileNames()).toEqual(["Setup.md", "intro.md", "api.md", "README.md"]);
    expect(fileNames()).toContain("intro.md");
    expect(fileNames()).toContain("README.md");
    expect(dirButton("docs").getAttribute("aria-expanded")).toBe("true");
    expect(dirButton("src").getAttribute("aria-expanded")).toBe("false");
  });

  it("点击目录切换展开并写入存储", () => {
    mount();
    click(dirButton("src"));
    expect(dirButton("src").getAttribute("aria-expanded")).toBe("true");
    expect(dirButton("lib").getAttribute("aria-expanded")).toBe("false");
    click(dirButton("lib"));
    expect(fileNames()).toContain("a.ts");
    expect(stored()?.sort()).toEqual(["docs", "docs/guide", "src", "src/lib"]);
    click(dirButton("guide"));
    expect(fileNames()).not.toContain("intro.md");
  });

  it("全部展开与全部收起", () => {
    mount();
    click(byLabel("全部展开"));
    expect(fileNames()).toContain("a.ts");
    expect(fileNames()).toContain("api.md");
    click(byLabel("全部收起"));
    expect(stored()).toEqual([]);
    expect(fileNames()).toEqual(["README.md"]);
  });

  it("展开状态重新挂载后恢复", () => {
    mount();
    click(byLabel("全部收起"));
    act(() => root.unmount());
    root = createRoot(container);
    resetLocalViewStoreForTest();
    mount(null);
    expect(fileNames()).toEqual(["README.md"]);
  });

  it("打开新文件时把它的祖先目录并入展开集合", () => {
    window.localStorage.setItem(KEY, JSON.stringify([]));
    mount("src/lib/a.ts");
    expect(fileNames()).toContain("a.ts");
    expect(stored()?.sort()).toEqual(["src", "src/lib"]);
  });

  it("存储值损坏时回退默认", () => {
    window.localStorage.setItem(KEY, "{坏");
    mount();
    expect(fileNames()).toContain("intro.md");
    expect(fileNames()).not.toContain("a.ts");
  });
});

describe("DocTreeView 搜索", () => {
  it("筛出命中的文件、展开祖先、显示计数，清空后恢复", () => {
    mount("README.md");
    expect(fileNames()).toEqual(["README.md"]);
    type("guide");
    expect(fileNames().sort()).toEqual(["Setup.md", "intro.md"]);
    expect(container.textContent).toContain("2 个匹配");
    expect(stored()).toBeNull();
    type("");
    expect(fileNames()).toEqual(["README.md"]);
    expect(container.textContent).not.toContain("个匹配");
  });

  it("搜索时收起目录只改内存，存储不变，清空后恢复原展开状态", () => {
    window.localStorage.setItem(KEY, JSON.stringify(["src"]));
    mount("README.md");
    expect(fileNames()).toEqual(["README.md"]);
    type("guide");
    expect(fileNames().sort()).toEqual(["Setup.md", "intro.md"]);
    click(dirButton("guide"));
    expect(fileNames()).toEqual([]);
    click(byLabel("全部展开"));
    expect(fileNames().sort()).toEqual(["Setup.md", "intro.md"]);
    click(byLabel("全部收起"));
    expect(fileNames()).toEqual([]);
    expect(stored()).toEqual(["src"]);
    type("");
    expect(dirButton("src").getAttribute("aria-expanded")).toBe("true");
    expect(dirButton("docs").getAttribute("aria-expanded")).toBe("false");
    expect(stored()).toEqual(["src"]);
  });

  it("命中的文件名片段用 mark 高亮", () => {
    mount();
    type("SET");
    const mark = container.querySelector("mark");
    expect(mark?.textContent).toBe("Set");
  });

  it("没有匹配时给出提示", () => {
    mount();
    type("zzz");
    expect(container.textContent).toContain("没有匹配的文件");
  });

  it("勾选正则后按正则匹配，无效正则提示且不筛选", () => {
    mount("README.md");
    const regex = container.querySelector<HTMLButtonElement>('button[role="checkbox"]')!;
    click(regex);
    type("\\.ts$");
    expect(fileNames()).toEqual(["a.ts"]);
    type("(");
    expect(container.textContent).toContain("正则无效");
    expect(fileNames()).toEqual(["README.md"]);
  });
});

describe("DocTreeView 链接", () => {
  it("链接带机器参数，当前文件标记 data-active", () => {
    mount();
    const link = container.querySelector<HTMLAnchorElement>('a[data-active="true"]')!;
    expect(link.getAttribute("href")).toBe("/p/p1/docs/docs/guide/intro.md?m=m1");
  });

  it("没有机器时不带参数", () => {
    mount("docs/guide/intro.md", null);
    expect(container.querySelector("a")!.getAttribute("href")).toBe("/p/p1/docs/docs/guide/Setup.md");
  });
});
