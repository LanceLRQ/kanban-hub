import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DocSidebarPanel, scrollTopToReveal } from "./doc-sidebar-panel";

describe("DocSidebarPanel", () => {
  const html = renderToStaticMarkup(
    <DocSidebarPanel title="文件" className="kh-doc-tree-box" bodyClassName="max-h-[50vh]">
      <p>内容</p>
    </DocSidebarPanel>,
  );

  it("默认展开：标题按钮 aria-expanded 为 true，内容照常渲染", () => {
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("<p>内容</p>");
    expect(html).not.toContain("max-md:hidden");
  });

  it("内容区在内部滚动，标题栏不随内容滚走", () => {
    expect(html).toMatch(/class="[^"]*kh-doc-panel-body[^"]*overflow-y-auto/);
    expect(html).toContain("max-h-[50vh]");
  });

  it("折叠只在窄屏生效：宽屏下标题不可点击、不显示折叠箭头", () => {
    expect(html).toMatch(/<button[^>]*class="[^"]*md:pointer-events-none/);
    expect(html).toMatch(/<svg[^>]*class="[^"]*md:hidden/);
  });
});

describe("scrollTopToReveal", () => {
  it("当前项已经在可见范围内时不滚动", () => {
    expect(scrollTopToReveal({ itemTop: 100, itemHeight: 24, viewHeight: 400, scrollTop: 0 })).toBe(0);
  });

  it("当前项在可见范围下方时，滚到让它处在上方三分之一处", () => {
    expect(scrollTopToReveal({ itemTop: 1000, itemHeight: 24, viewHeight: 300, scrollTop: 0 })).toBe(900);
  });

  it("当前项在可见范围上方时同样滚过去，且不小于 0", () => {
    expect(scrollTopToReveal({ itemTop: 50, itemHeight: 24, viewHeight: 300, scrollTop: 800 })).toBe(0);
  });
});
