import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * `(app)` 分组下每个页面和布局都必须自己校验会话（通过 `authedPageServices` 或
 * `requirePageUser`），不能只依赖 `(app)/layout.tsx` 里做过一次校验：App Router 的局部
 * 渲染（RSC 导航）按需只重跑发生变化的那一段，不会重新执行没有变化的祖先布局。这里用 glob
 * 扫出所有 `page.tsx`/`layout.tsx`，逐个断言源码里调用了会话校验入口，且不再直接使用
 * 未经校验的 `getServices`/`pageServices`，防止以后新增页面漏掉这一步。
 */

const APP_DIR = path.join(__dirname);

function findPageAndLayoutFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...findPageAndLayoutFiles(full));
    } else if (entry.name === "page.tsx" || entry.name === "layout.tsx") {
      found.push(full);
    }
  }
  return found;
}

const files = findPageAndLayoutFiles(APP_DIR);

describe("(app) 下的页面与布局都经过会话校验", () => {
  it("至少能扫到已知的页面和布局文件", () => {
    expect(files.length).toBeGreaterThanOrEqual(9);
  });

  it.each(files)("%s 调用了 authedPageServices/requirePageUser，且不直接用未校验的取服务入口", (file) => {
    const source = fs.readFileSync(file, "utf8");
    const hasGuard = source.includes("authedPageServices(") || source.includes("requirePageUser(");
    expect(hasGuard).toBe(true);
    expect(source).not.toContain("getServices(");
    expect(source).not.toContain("pageServices(");
  });
});
