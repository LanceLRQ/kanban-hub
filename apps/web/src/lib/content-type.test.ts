import { describe, expect, it } from "vitest";
import { contentKindOf, contentTypeOf } from "./content-type";

describe("contentKindOf", () => {
  it("markdown 在上限内渲染，超过上限归为 too-large", () => {
    expect(contentKindOf("docs/readme.md", 100)).toBe("markdown");
    expect(contentKindOf("docs/readme.MD", 100)).toBe("markdown");
    expect(contentKindOf("docs/readme.markdown", 2 * 1024 * 1024)).toBe("markdown");
    expect(contentKindOf("docs/readme.md", 2 * 1024 * 1024 + 1)).toBe("too-large");
  });

  it("其他文本在上限内高亮，超过上限归为 too-large", () => {
    expect(contentKindOf("src/index.ts", 1024)).toBe("text");
    expect(contentKindOf("notes.TXT", 1024 * 1024)).toBe("text");
    expect(contentKindOf("notes.txt", 1024 * 1024 + 1)).toBe("too-large");
  });

  it("图片、html、svg、pdf 不受大小限制", () => {
    expect(contentKindOf("a.png", 999_999_999)).toBe("image");
    expect(contentKindOf("a.JPG", 1)).toBe("image");
    expect(contentKindOf("demo.html", 999_999_999)).toBe("html");
    expect(contentKindOf("icon.svg", 999_999_999)).toBe("svg");
    expect(contentKindOf("doc.pdf", 999_999_999)).toBe("pdf");
  });

  it("认不出的扩展名（含没有扩展名的文件）归为 binary", () => {
    expect(contentKindOf("archive.zip", 10)).toBe("binary");
    expect(contentKindOf("font.woff2", 10)).toBe("binary");
    expect(contentKindOf("LICENSE", 10)).toBe("binary");
  });
});

describe("contentTypeOf", () => {
  it("文本类带 charset=utf-8", () => {
    expect(contentTypeOf("docs/readme.md")).toBe("text/markdown; charset=utf-8");
    expect(contentTypeOf("notes.txt")).toBe("text/plain; charset=utf-8");
    expect(contentTypeOf("index.HTML")).toBe("text/html; charset=utf-8");
  });

  it("图片、svg、pdf 用对应的 mime，不带 charset", () => {
    expect(contentTypeOf("a.png")).toBe("image/png");
    expect(contentTypeOf("a.JPG")).toBe("image/jpeg");
    expect(contentTypeOf("icon.svg")).toBe("image/svg+xml");
    expect(contentTypeOf("doc.pdf")).toBe("application/pdf");
  });

  it("未知类型用 application/octet-stream", () => {
    expect(contentTypeOf("archive.zip")).toBe("application/octet-stream");
  });
});
