import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardNav, containerAnchorId } from "./board-nav";

describe("BoardNav", () => {
  const html = renderToStaticMarkup(
    <BoardNav
      ariaLabel="容器导航"
      entries={[
        { id: "c1", code: "M1", title: "模型管理核心（Mac）", taskCount: 5 },
        { id: "c2", code: null, title: "杂项", taskCount: 12 },
      ]}
    />,
  );

  it("每个容器一行：编号 + 标题，指向容器的锚点", () => {
    expect(html).toContain('aria-label="容器导航"');
    expect(html).toContain(`data-target="${containerAnchorId("c1")}"`);
    expect(html).toContain("M1");
    expect(html).toContain("模型管理核心（Mac）");
    expect(html).toContain("杂项");
  });

  it("编号是单独的小标签，不参与省略；标题超长时单行省略，任务数贴右", () => {
    expect(html).toMatch(/class="kh-board-nav-code[^"]*shrink-0[^"]*"[^>]*>M1</);
    expect(html).toMatch(/class="[^"]*truncate[^"]*"[^>]*>模型管理核心/);
    expect(html).toMatch(/class="[^"]*ml-auto[^"]*shrink-0[^"]*"[^>]*>5</);
    expect(html).toMatch(/>12</);
  });

  it("没有编号的容器只显示标题；不渲染状态标记", () => {
    expect(html.match(/kh-board-nav-code/g)).toHaveLength(1);
    expect(html).not.toContain("kh-status-mark");
    expect(html).not.toContain("kh-board-chip");
  });
});
