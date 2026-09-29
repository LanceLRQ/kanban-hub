import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { isTruncated, TruncatedText } from "./truncated-text";

describe("isTruncated", () => {
  it("内容比可见区域宽或高时算被截断", () => {
    expect(isTruncated({ scrollWidth: 300, clientWidth: 200, scrollHeight: 20, clientHeight: 20 })).toBe(true);
    expect(isTruncated({ scrollWidth: 200, clientWidth: 200, scrollHeight: 60, clientHeight: 40 })).toBe(true);
  });

  it("没有溢出，或只差不到 1 像素的舍入误差时不算", () => {
    expect(isTruncated({ scrollWidth: 200, clientWidth: 200, scrollHeight: 20, clientHeight: 20 })).toBe(false);
    expect(isTruncated({ scrollWidth: 201, clientWidth: 200, scrollHeight: 20, clientHeight: 20 })).toBe(false);
  });

  it("元素不存在时不算", () => {
    expect(isTruncated(null)).toBe(false);
  });
});

describe("TruncatedText", () => {
  it("默认单行省略，文字直接渲染，提示层初始不出现", () => {
    const html = renderToStaticMarkup(<TruncatedText text="很长的一段文字" className="text-sm" />);
    expect(html).toMatch(/<span[^>]*class="[^"]*truncate[^"]*text-sm[^"]*"[^>]*>很长的一段文字<\/span>/);
    expect(html).not.toContain("tooltip-content");
  });

  it("lines=2 时按两行截断", () => {
    const html = renderToStaticMarkup(<TruncatedText text="焦点" lines={2} />);
    expect(html).toContain("line-clamp-2");
    expect(html).not.toMatch(/class="[^"]*\btruncate\b/);
  });
});
