import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BackupCreateFields } from "./backup-create-form";

const labels = {
  passwordPlaceholder: "备份密码（AES-256）",
  includeHistory: "含历史",
  createButton: "创建加密备份",
  creating: "创建中…",
};

describe("BackupCreateFields", () => {
  function render(pending: boolean, includeGit = true): string {
    return renderToStaticMarkup(
      <BackupCreateFields
        password=""
        onPasswordChange={() => {}}
        includeGit={includeGit}
        onIncludeGitChange={() => {}}
        pending={pending}
        onCreate={() => {}}
        labels={labels}
      />,
    );
  }

  it("默认可点：密码输入框、“含历史”默认勾选、创建按钮", () => {
    const html = render(false);
    expect(html).toContain('type="password"');
    expect(html).toContain("备份密码（AES-256）");
    expect(html).toMatch(/aria-checked="true"/);
    expect(html).toContain("创建加密备份");
    // 类名里有 disabled: 开头的样式变体，这里只认真正的 disabled 属性
    expect(html).not.toMatch(/disabled=""/);
  });

  it("创建进行中：输入、开关与按钮都禁用，按钮换成“创建中”", () => {
    const html = render(true);
    expect(html).toContain("创建中…");
    expect(html).not.toContain("创建加密备份");
    // 密码输入框与“含历史”开关都禁用（类名里有 disabled: 样式变体，只认 disabled 属性）
    expect(html).toMatch(/<input[^>]*type="password"[^>]*disabled=""/);
    expect(html).toMatch(/role="checkbox"[^>]*disabled=""/);
    expect(html).toMatch(/disabled=""[^>]*>创建中…/);
  });

  it("不勾“含历史”时开关状态如实渲染", () => {
    expect(render(false, false)).toMatch(/aria-checked="false"/);
  });
});
