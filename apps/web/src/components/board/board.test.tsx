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

function section(id: string, title: string, tasks: BoardTaskView[]): BoardSectionView {
  return {
    container: { id, kind: "feature", code: id.toUpperCase(), label: id, title, targetVersion: null, targetDate: null, targetDateLabel: null, manualStatus: null, manualReason: null, version: 1 },
    status: "in_progress",
    collapsed: false,
    taskCount: tasks.length,
    doneCount: 0,
    openCount: tasks.length,
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

let container: HTMLDivElement;
let root: Root;

function mount() {
  act(() => {
    root.render(
      <NextIntlClientProvider locale="zh-CN" messages={{ board, common, enums }}>
        <Board view={view} />
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
    expect(chip("待开始").getAttribute("aria-pressed")).toBe("true");
  });

  it("切换状态标签后，不满足的任务行被隐藏，表头计数不变", () => {
    mount();
    click(chip("待开始"));
    // 默认全选，点一个等于取消它
    expect(rowTitles().some((r) => r.includes("写文档"))).toBe(false);
    expect(rowTitles().some((r) => r.includes("跑测试"))).toBe(true);
    expect(chip("待开始").getAttribute("aria-pressed")).toBe("false");
    expect(text()).toContain("3 个任务");
  });

  it("分区里的任务全被筛掉时显示“N 个任务被筛选隐藏”，分区本身保留", () => {
    mount();
    click(chip("待开始"));
    expect(text()).toContain("1 个任务被筛选隐藏");
    expect(container.querySelectorAll("section")).toHaveLength(2);
    expect(text()).toContain("第二块");
  });

  it("?task= 指向被筛选隐藏的任务时，侧栏仍然打开并显示该任务", () => {
    nav.query = "task=t1";
    mount();
    click(chip("待开始"));
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

  it("全部取消选中视同全部选中", () => {
    mount();
    click(chip("待开始"));
    for (const label of ["进行中", "复核中", "已完成", "挂起", "已取消"]) click(chip(label));
    expect(rowTitles()).toHaveLength(4);
    expect(chip("待开始").getAttribute("aria-pressed")).toBe("true");
  });

  it("重置后恢复默认视图", () => {
    mount();
    click(chip("只看待你处理"));
    click(chip("待开始"));
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
