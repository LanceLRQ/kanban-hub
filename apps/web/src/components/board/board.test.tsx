// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import type { TaskStatus } from "@kanban-hub/core/schema";
import board from "../../../messages/zh-CN/board.json";
import common from "../../../messages/zh-CN/common.json";
import enums from "../../../messages/zh-CN/enums.json";
import type { BoardSectionView, BoardTaskView, BoardView } from "@/server/views/board";
import { resetLocalViewStoreForTest } from "@/lib/client/use-local-view";
import { Board } from "./board";

const nav = vi.hoisted(() => ({ query: "" }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/p/p1",
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.query),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = "kh-board-view";

function task(id: string, title: string, status: TaskStatus, extra: { human?: boolean; updatedAt?: string } = {}): BoardTaskView {
  return {
    id,
    ref: `#${id}`,
    version: 1,
    containerId: "c1",
    code: null,
    title,
    status,
    suspendReason: null,
    human: extra.human ? { kind: "decision", note: "要你定", since: "2026-10-01T00:00:00.000Z" } : null,
    group: null,
    note: "",
    docRefs: [],
    checklist: [],
    dueDate: null,
    checklistProgress: { done: 0, total: 0 },
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: extra.updatedAt ?? "2026-10-01T00:00:00.000Z",
    meta: { group: null, docRefs: [], note: null, main: null },
  } as unknown as BoardTaskView;
}

function section(id: string, title: string, tasks: BoardTaskView[], status: BoardSectionView["status"] = "in_progress"): BoardSectionView {
  const manualStatus = status === "cancelled" || status === "backlog" || status === "suspended" ? status : null;
  return {
    container: { id, kind: status === null ? "misc" : "feature", code: status === null ? null : id.toUpperCase(), label: id, title, targetVersion: null, targetDate: null, targetDateLabel: null, manualStatus, manualReason: null, version: 1 },
    status,
    collapsed: status === "done" || status === "cancelled",
    taskCount: tasks.length,
    doneCount: tasks.filter((t) => t.status === "done").length,
    startedCount: tasks.filter((t) => t.status === "in_progress" || t.status === "review" || t.status === "suspended").length,
    cancelledCount: 0,
    completedDate: null,
    tasks,
  } as BoardSectionView;
}

const view: BoardView = {
  projectId: "p1",
  sections: [
    section("c1", "第一块", [task("t1", "写文档", "todo"), task("t2", "跑测试", "in_progress", { human: true }), task("t3", "发版本", "done")]),
    section("c2", "第二块", [task("t4", "只有这一个", "todo")]),
  ],
  containerOptions: [],
};

/** 含已完成、已取消、杂项的看板；顺序同 boardSections：正常 → 杂项 → 已取消 */
const mixedView: BoardView = {
  projectId: "p1",
  sections: [
    section("c1", "进行中块", [task("a1", "甲任务", "todo"), task("a2", "乙任务", "done")]),
    section("c2", "完成块", [task("b1", "丙任务", "done")], "done"),
    section("c0", "杂项块", [task("m1", "丁任务", "todo")], null),
    section("c3", "取消块", [task("x1", "戊任务", "cancelled")], "cancelled"),
  ],
  containerOptions: [],
};

let container: HTMLDivElement;
let root: Root;

function mount(v: BoardView = view) {
  act(() => {
    root.render(
      <NextIntlClientProvider locale="zh-CN" messages={{ board, common, enums }}>
        <Board view={v} />
      </NextIntlClientProvider>,
    );
  });
}

const text = () => container.textContent ?? "";
const chip = (label: string) => {
  const el = [...container.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find((b) => (b.textContent ?? "").endsWith(label));
  if (!el) throw new Error(`没有标签 ${label}`);
  return el;
};
const click = (el: Element) => act(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const buttonStartingWith = (prefix: string) => [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").startsWith(prefix));
const statusTrigger = () => buttonStartingWith("状态")!;
/** Radix 下拉由 pointerdown 打开，菜单经 Portal 渲染在 body 里 */
const openMenu = (trigger: Element) => act(() => trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })));
const menuItem = (label: string) => {
  const el = [...document.body.querySelectorAll('[role^="menuitem"]')].find((i) => (i.textContent ?? "").includes(label));
  if (!el) throw new Error(`没有菜单项 ${label}`);
  return el;
};
const pickStatus = (...labels: string[]) => {
  openMenu(statusTrigger());
  for (const label of labels) click(menuItem(label));
};
const sectionTitles = () => [...container.querySelectorAll("section")].map((s) => s.getAttribute("aria-label"));
const navTitles = () => [...container.querySelectorAll(".kh-board-nav-item")].map((b) => b.textContent ?? "");
const foldButton = (title: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="展开 ${title}"], button[aria-label="收起 ${title}"]`)!;
const FOLD_KEY = "kh-board-fold:p1";
const rowNames = () => rowTitles().map((r) => /[甲乙丙丁戊]任务/.exec(r)?.[0]);
const rowTitles = () => [...container.querySelectorAll(".kh-task-row")].map((r) => r.textContent ?? "");
const newTaskInputs = () => container.querySelectorAll(`input[aria-label^="在 "]`).length;
const resetButton = () => [...container.querySelectorAll("button")].find((b) => b.textContent === "重置");

beforeEach(() => {
  nav.query = "";
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

describe("看板筛选与排序", () => {
  it("默认视图：全部任务可见，每个分区都有新建任务输入框，没有重置按钮", () => {
    mount();
    expect(rowTitles()).toHaveLength(4);
    expect(newTaskInputs()).toBe(2);
    expect(resetButton()).toBeUndefined();
    expect(statusTrigger().textContent).toBe("状态");
    expect(buttonStartingWith("按")).toBeUndefined();
  });

  it("按任务筛选：不满足的任务行被隐藏，表头计数不变", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ statuses: ["in_progress"], filterMode: "task", humanOnly: false, sort: "manual", direction: "desc" }));
    mount();
    expect(rowTitles().some((r) => r.includes("写文档"))).toBe(false);
    expect(rowTitles().some((r) => r.includes("跑测试"))).toBe(true);
    expect(text()).toContain("3 个任务");
  });

  it("分区里的任务全被筛掉时显示“N 个任务被筛选隐藏”，分区本身保留", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ statuses: ["in_progress"], filterMode: "task", humanOnly: false, sort: "manual", direction: "desc" }));
    mount();
    expect(text()).toContain("1 个任务被筛选隐藏");
    expect(container.querySelectorAll("section")).toHaveLength(2);
    expect(text()).toContain("第二块");
  });

  it("?task= 指向被筛选隐藏的任务时，侧栏仍然打开并显示该任务", () => {
    nav.query = "task=t1";
    window.localStorage.setItem(KEY, JSON.stringify({ statuses: ["in_progress"], filterMode: "task", humanOnly: false, sort: "manual", direction: "desc" }));
    mount();
    expect(rowTitles().some((r) => r.includes("写文档"))).toBe(false);
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain("写文档");
  });

  it("只看待你处理", () => {
    mount();
    click(chip("只看待你处理"));
    expect(rowTitles()).toHaveLength(1);
    expect(rowTitles()[0]).toContain("跑测试");
  });

  it("非默认视图下隐藏新建任务输入框", () => {
    mount();
    click(chip("只看待你处理"));
    expect(newTaskInputs()).toBe(0);
  });

  it("七项全选等同不筛，存成空数组", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ statuses: ["in_progress"], filterMode: "task", humanOnly: false, sort: "manual", direction: "desc" }));
    mount();
    openMenu(statusTrigger());
    for (const label of ["待开始", "复核中", "已完成", "储备", "挂起", "已取消"]) click(menuItem(label));
    expect(JSON.parse(window.localStorage.getItem(KEY)!).statuses).toEqual([]);
    expect(rowTitles()).toHaveLength(4);
    expect(statusTrigger().textContent).toBe("状态");
  });

  it("重置后恢复默认视图", () => {
    mount();
    click(chip("只看待你处理"));
    pickStatus("进行中");
    expect(rowTitles()).toHaveLength(1);
    click(resetButton()!);
    expect(rowTitles()).toHaveLength(4);
    expect(newTaskInputs()).toBe(2);
    expect(resetButton()).toBeUndefined();
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("选择会写进 localStorage，刷新（重新挂载）后恢复", () => {
    mount();
    click(chip("只看待你处理"));
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toMatchObject({ humanOnly: true });
    act(() => root.unmount());
    resetLocalViewStoreForTest();
    root = createRoot(container);
    mount();
    expect(rowTitles()).toHaveLength(1);
    expect(chip("只看待你处理").getAttribute("aria-pressed")).toBe("true");
    expect(resetButton()).toBeDefined();
  });

  it("本地保存了按状态排序时，分区内按状态顺序显示", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ statuses: [], humanOnly: false, sort: "status", direction: "desc" }));
    mount();
    const titles = rowTitles();
    expect(titles[0]).toContain("跑测试");
    expect(titles[1]).toContain("写文档");
    expect(titles[2]).toContain("发版本");
  });

  it("方向按钮只在时间排序下出现，点击切换方向", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ statuses: [], humanOnly: false, sort: "manual", direction: "desc" }));
    mount();
    expect(container.querySelector("[data-testid=board-direction]")).toBeNull();
    act(() => root.unmount());
    resetLocalViewStoreForTest();
    window.localStorage.setItem(KEY, JSON.stringify({ statuses: [], humanOnly: false, sort: "updated", direction: "desc" }));
    root = createRoot(container);
    mount();
    const dir = container.querySelector("[data-testid=board-direction]")!;
    expect(dir.textContent).toBe("新的在前");
    click(dir);
    expect(container.querySelector("[data-testid=board-direction]")!.textContent).toBe("旧的在前");
  });

  it("保存的值非法时回退默认视图", () => {
    window.localStorage.setItem(KEY, "{\"sort\":\"bogus\"}");
    mount();
    expect(rowTitles()).toHaveLength(4);
    expect(resetButton()).toBeUndefined();
  });
});

describe("里程碑折叠", () => {
  it("默认：进行中、杂项展开，已完成、已取消收起", () => {
    mount(mixedView);
    expect(foldButton("进行中块").getAttribute("aria-expanded")).toBe("true");
    expect(foldButton("杂项块").getAttribute("aria-expanded")).toBe("true");
    expect(foldButton("完成块").getAttribute("aria-expanded")).toBe("false");
    expect(foldButton("取消块").getAttribute("aria-expanded")).toBe("false");
    expect(rowNames()).toEqual(["甲任务", "乙任务", "丁任务"]);
  });

  it("进行中的里程碑可以折叠，折叠后表头仍显示摘要", () => {
    mount(mixedView);
    click(foldButton("进行中块"));
    expect(foldButton("进行中块").getAttribute("aria-expanded")).toBe("false");
    expect(rowTitles().some((r) => r.includes("甲任务"))).toBe(false);
    expect(text()).toContain("2 个任务");
  });

  it("点表头空白处也切换折叠", () => {
    mount(mixedView);
    click(container.querySelector("section[aria-label=完成块] .kh-board-head")!);
    expect(foldButton("完成块").getAttribute("aria-expanded")).toBe("true");
    expect(rowTitles().some((r) => r.includes("丙任务"))).toBe(true);
  });

  it("手动切换按项目写进 localStorage，重新挂载后恢复；没切换过的仍按默认", () => {
    mount(mixedView);
    click(foldButton("进行中块"));
    click(foldButton("完成块"));
    expect(JSON.parse(window.localStorage.getItem(FOLD_KEY)!)).toEqual({ c1: false, c2: true });
    act(() => root.unmount());
    resetLocalViewStoreForTest();
    root = createRoot(container);
    mount(mixedView);
    expect(foldButton("进行中块").getAttribute("aria-expanded")).toBe("false");
    expect(foldButton("完成块").getAttribute("aria-expanded")).toBe("true");
    expect(foldButton("取消块").getAttribute("aria-expanded")).toBe("false");
    expect(foldButton("杂项块").getAttribute("aria-expanded")).toBe("true");
  });

  it("折叠记录损坏时回退为默认", () => {
    window.localStorage.setItem(FOLD_KEY, '{"c1":"x"}');
    mount(mixedView);
    expect(foldButton("进行中块").getAttribute("aria-expanded")).toBe("true");
  });

  it("左栏点击只滚动，不展开已收起的里程碑", () => {
    mount(mixedView);
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const item = [...container.querySelectorAll(".kh-board-nav-item")].find((b) => (b.textContent ?? "").includes("完成块"))!;
    click(item);
    expect(scrollIntoView).toHaveBeenCalled();
    expect(foldButton("完成块").getAttribute("aria-expanded")).toBe("false");
  });
});

describe("已取消的里程碑", () => {
  it("排在最后，不进左栏导航", () => {
    mount(mixedView);
    expect(sectionTitles()).toEqual(["进行中块", "完成块", "杂项块", "取消块"]);
    expect(navTitles().some((n) => n.includes("取消块"))).toBe(false);
    expect(navTitles()).toHaveLength(3);
  });
});

describe("状态下拉", () => {
  it("按钮文字：未选 / 选 1 项 / 选多项", () => {
    mount(mixedView);
    expect(statusTrigger().textContent).toBe("状态");
    pickStatus("已完成");
    expect(statusTrigger().textContent).toBe("状态（已完成）");
    click(menuItem("进行中"));
    expect(statusTrigger().textContent).toBe("状态（进行中等 2 项）");
  });

  it("菜单项共 7 项，复核中标注仅任务、储备标注仅里程碑", () => {
    mount(mixedView);
    openMenu(statusTrigger());
    const items = [...document.body.querySelectorAll('[role="menuitemcheckbox"]')].map((i) => i.textContent ?? "");
    expect(items).toHaveLength(7);
    ["待开始", "进行中", "复核中仅任务", "已完成", "储备仅里程碑", "挂起", "已取消"].forEach((label, i) => expect(items[i]).toContain(label));
  });

  it("选了状态才出现筛选方式，默认按里程碑", () => {
    mount(mixedView);
    expect(buttonStartingWith("按")).toBeUndefined();
    pickStatus("已完成");
    expect(buttonStartingWith("按")!.textContent).toBe("按里程碑");
  });

  it("按里程碑：只留状态符合的里程碑和杂项，里面的任务全部显示，左栏同步", () => {
    mount(mixedView);
    pickStatus("已完成");
    expect(sectionTitles()).toEqual(["完成块", "杂项块"]);
    expect(navTitles().some((n) => n.includes("进行中块"))).toBe(false);
    // 杂项里的任务不受筛选影响；完成块默认收起
    expect(rowNames()).toEqual(["丁任务"]);
  });

  it("按任务：里程碑全留，只筛任务行", () => {
    mount(mixedView);
    pickStatus("已完成");
    openMenu(buttonStartingWith("按")!);
    click(menuItem("按任务"));
    expect(sectionTitles()).toEqual(["进行中块", "完成块", "杂项块", "取消块"]);
    expect(rowNames()).toEqual(["乙任务"]);
  });

  it("按里程碑和任务：两层都筛", () => {
    mount(mixedView);
    pickStatus("进行中", "已完成");
    openMenu(buttonStartingWith("按")!);
    click(menuItem("按里程碑和任务"));
    expect(sectionTitles()).toEqual(["进行中块", "完成块", "杂项块"]);
    expect(rowNames()).toEqual(["乙任务"]);
  });

  it("只按里程碑筛选时新建任务输入框仍在；按任务筛选时隐藏", () => {
    mount(mixedView);
    pickStatus("进行中");
    expect(newTaskInputs()).toBeGreaterThan(0);
    openMenu(buttonStartingWith("按")!);
    click(menuItem("按任务"));
    expect(newTaskInputs()).toBe(0);
  });

  it("全部里程碑都被筛掉（杂项也没有）时提示没有符合条件，并可重置", () => {
    mount(view);
    pickStatus("已完成");
    expect(text()).toContain("没有符合条件的里程碑");
    expect(container.querySelectorAll("section")).toHaveLength(0);
    click(resetButton()!);
    expect(container.querySelectorAll("section")).toHaveLength(2);
    expect(text()).not.toContain("没有符合条件的里程碑");
  });

  it("旧的本地存值（没有筛选方式）仍能读取", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ statuses: ["in_progress"], humanOnly: false, sort: "manual", direction: "desc" }));
    mount(mixedView);
    expect(statusTrigger().textContent).toBe("状态（进行中）");
    expect(sectionTitles()).toEqual(["进行中块", "杂项块"]);
  });
});

describe("里程碑表头的进度", () => {
  it("显示带颜色的 已完成/进行中/未开始 与总数，数字带含义说明，进度条按状态分段", () => {
    mount();
    const head = container.querySelector(`section[aria-label="第一块"] .kh-board-head`)!;
    const counts = [...head.querySelectorAll("[data-count]")].map((el) => [el.getAttribute("data-count"), el.textContent, el.getAttribute("aria-label")]);
    expect(counts).toEqual([
      ["done", "1", "已完成 1"],
      ["started", "1", "进行中 1（含复核中、挂起）"],
      ["todo", "1", "未开始 1"],
    ]);
    expect(head.textContent).toContain("1/1/1，共 3 个任务");
    const segments = [...head.querySelectorAll("[data-segment]")].map((el) => el.getAttribute("data-segment"));
    expect(segments).toEqual(["done", "started", "todo"]);
  });

  it("杂项也显示进度", () => {
    mount(mixedView);
    const head = container.querySelector(`section[aria-label="杂项块"] .kh-board-head`)!;
    expect(head.textContent).toContain("0/0/1，共 1 个任务");
    expect(head.querySelectorAll("[data-segment]")).toHaveLength(1);
  });
});

