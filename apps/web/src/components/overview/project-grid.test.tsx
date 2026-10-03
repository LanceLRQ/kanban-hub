// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import overview from "../../../messages/zh-CN/overview.json";
import enums from "../../../messages/zh-CN/enums.json";
import type { Cycle } from "@kanban-hub/core/schema";
import { resetLocalViewStoreForTest } from "@/lib/client/use-local-view";
import type { ProjectFilterMeta } from "@/lib/project-filter";
import { ProjectGrid } from "./project-grid";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = "kh-projects-view";

function item(id: string, cycle: Cycle, lastEventAt: string | null) {
  const meta: ProjectFilterMeta = {
    id,
    cycle,
    health: "on_track",
    progress: { done: 1, total: 2 },
    createdAt: "2026-10-01T00:00:00.000Z",
    lastEventAt,
  };
  return { meta, node: <a key={id} data-card={id} className="kh-overview-card">{id}</a> };
}

const items = [
  item("alpha", "development", "2026-10-03T00:00:00.000Z"),
  item("beta", "design", "2026-10-02T00:00:00.000Z"),
  item("old", "archived", "2026-10-04T00:00:00.000Z"),
];

let container: HTMLDivElement;
let root: Root;

function mount(list = items) {
  act(() => {
    root.render(
      <NextIntlClientProvider locale="zh-CN" messages={{ overview, enums }}>
        <ProjectGrid items={list} title="项目" tag="projects" />
      </NextIntlClientProvider>,
    );
  });
}

const cards = () => [...container.querySelectorAll("[data-card]")].map((el) => el.getAttribute("data-card"));
const chip = (label: string) => {
  const el = [...container.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find((b) => b.textContent === label);
  if (!el) throw new Error(`没有标签 ${label}`);
  return el;
};
const click = (el: Element) => act(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const resetButtons = () => [...container.querySelectorAll("button")].filter((b) => (b.textContent ?? "").includes("重置"));

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

describe("项目列表筛选与排序", () => {
  it("默认隐藏归档，计数显示可见数 / 总数，没有重置按钮", () => {
    mount();
    expect(cards()).toEqual(["alpha", "beta"]);
    expect(container.querySelector("h2")!.nextElementSibling!.textContent).toBe("2 / 3");
    expect(resetButtons()).toHaveLength(0);
    expect(chip("归档").getAttribute("aria-pressed")).toBe("false");
    expect(chip("开发期").getAttribute("aria-pressed")).toBe("true");
  });

  it("没有任何项目被隐藏时计数只显示总数", () => {
    mount(items.slice(0, 2));
    expect(container.querySelector("h2")!.nextElementSibling!.textContent).toBe("2");
  });

  it("勾选归档后归档项目出现，并排在最后", () => {
    mount();
    click(chip("归档"));
    expect(cards()).toEqual(["alpha", "beta", "old"]);
    expect(container.querySelector("h2")!.nextElementSibling!.textContent).toBe("3");
  });

  it("按进度筛选；全部筛空时出现提示和重置按钮，重置后恢复", () => {
    mount();
    click(chip("已完成"));
    expect(cards()).toEqual([]);
    expect(container.textContent).toContain("没有符合条件的项目");
    const reset = resetButtons();
    expect(reset.length).toBeGreaterThan(0);
    click(reset[reset.length - 1]!);
    expect(cards()).toEqual(["alpha", "beta"]);
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("选择写进 localStorage，重新挂载后恢复", () => {
    mount();
    click(chip("设计期"));
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toMatchObject({ cycles: ["development", "iteration", "maintenance"] });
    act(() => root.unmount());
    resetLocalViewStoreForTest();
    root = createRoot(container);
    mount();
    expect(cards()).toEqual(["alpha"]);
    expect(chip("设计期").getAttribute("aria-pressed")).toBe("false");
  });

  it("本地保存了创建时间正序时按该顺序显示；方向按钮切换", () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ cycles: [], healths: [], progress: "all", sort: "activity", direction: "asc" }),
    );
    mount();
    expect(cards()).toEqual(["beta", "alpha", "old"]);
    const dir = container.querySelector("[data-testid=projects-direction]")!;
    expect(dir.textContent).toBe("旧的在前");
    click(dir);
    expect(cards()).toEqual(["alpha", "beta", "old"]);
  });

  it("本地保存的值不合法时回退默认", () => {
    window.localStorage.setItem(KEY, "{\"sort\":\"nope\"}");
    mount();
    expect(cards()).toEqual(["alpha", "beta"]);
  });
});
