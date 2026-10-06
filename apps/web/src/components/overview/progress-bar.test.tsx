// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProgressBar } from "./progress-bar";

function render(done: number, started: number, total: number): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<ProgressBar done={done} started={started} total={total} title="明细" />);
  return host.firstElementChild as HTMLElement;
}

describe("ProgressBar", () => {
  it("10 个以内分段显示：已完成、已开始、待开始依次排列", () => {
    const bar = render(2, 3, 10);
    const segments = [...bar.querySelectorAll("[data-segment]")].map((el) => el.getAttribute("data-segment"));
    expect(segments).toEqual(["done", "done", "started", "started", "started", "todo", "todo", "todo", "todo", "todo"]);
    expect(bar.getAttribute("title")).toBe("明细");
  });

  it("超过 10 个改为连续条：已完成叠在最上层，已开始那层宽度含已完成", () => {
    const bar = render(1, 4, 20);
    expect(bar.querySelectorAll("[data-segment]")).toHaveLength(0);
    const started = bar.querySelector<HTMLElement>("[data-layer='started']")!;
    const done = bar.querySelector<HTMLElement>("[data-layer='done']")!;
    expect(started.style.width).toBe("25%");
    expect(done.style.width).toBe("5%");
    expect(bar.getAttribute("title")).toBe("明细");
  });

  it("没有任务时显示虚线空条", () => {
    const bar = render(0, 0, 0);
    expect(bar.className).toContain("border-dashed");
  });
});
