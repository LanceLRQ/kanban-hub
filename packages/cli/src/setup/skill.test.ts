import { describe, expect, it } from "vitest";
import { SKILL_MD } from "./skill";

/** 从正文里取出 frontmatter 部分（两条 --- 之间），逐行解析成字段名列表 */
function frontmatterFields(md: string): string[] {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(md);
  if (!match) throw new Error("找不到 frontmatter");
  return match[1]!
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => line.split(":")[0]!.trim());
}

describe("SKILL_MD", () => {
  it("frontmatter 只有 name 和 description 两个字段", () => {
    const fields = frontmatterFields(SKILL_MD);
    expect(fields).toEqual(["name", "description"]);
  });

  it("name 是 kanban-hub", () => {
    expect(SKILL_MD).toMatch(/^---\nname: kanban-hub\n/);
  });

  it("description 不超过 1024 个字符", () => {
    const match = /^description: (.+)$/m.exec(SKILL_MD);
    expect(match).not.toBeNull();
    expect(match![1]!.length).toBeLessThanOrEqual(1024);
  });

  it("不包含某一家 agent 特有的工具名（整词匹配，README 不算）", () => {
    for (const tool of ["Bash", "Read", "Write", "TodoWrite"]) {
      const re = new RegExp(`(?<![A-Za-z])${tool}(?![A-Za-z])`);
      expect(re.test(SKILL_MD), `不应包含工具名 ${tool}`).toBe(false);
    }
  });

  describe("覆盖规格 12.2 的每一类规则", () => {
    it("生效条件", () => {
      expect(SKILL_MD).toContain(".kanban-hub/");
    });

    it("上报规则：各个状态与命令", () => {
      for (const kw of ["in_progress", "review", "done", "suspended", "kh task human", "kh task add misc", "kh log", "kh project set"]) {
        expect(SKILL_MD, `应包含 ${kw}`).toContain(kw);
      }
    });

    it("指定容器和任务的写法", () => {
      expect(SKILL_MD).toContain("M2/2.3");
      expect(SKILL_MD).toContain("#短ID");
      expect(SKILL_MD).toContain("必须加引号");
    });

    it("--agent 的规则", () => {
      expect(SKILL_MD).toContain("--agent");
      expect(SKILL_MD).toContain("1 到 50 个可打印 ASCII 字符");
      expect(SKILL_MD).toContain("不能包含空格");
    });

    it("跨机器文档", () => {
      expect(SKILL_MD).toContain("kh docs ls");
      expect(SKILL_MD).toContain("kh docs cat");
    });

    it("冲突处理的五步", () => {
      expect(SKILL_MD).toContain("kh conflicts show");
      expect(SKILL_MD).toContain("kh conflicts resolve");
      expect(SKILL_MD).toContain("--edited");
      expect(SKILL_MD).toContain("问清楚再改");
      expect(SKILL_MD).toContain("另一个同步或拉取正在进行");
    });

    it("没有 hook 时的兜底规则", () => {
      expect(SKILL_MD).toContain("kh pull");
      expect(SKILL_MD).toContain("kh sync");
    });

    it("注册流程", () => {
      expect(SKILL_MD).toContain("kh register --dry-run");
    });

    it("导入流程的每一步", () => {
      for (const kw of [
        "~/.kanban-hub/imports/<项目>.yaml",
        "kh import <文件> --dry-run",
        "kh import <文件>",
        "不要修改原来的进度文档",
        "开发笔记",
        "/setup/migrate.md",
        "kh export",
      ]) {
        expect(SKILL_MD, `应包含 ${kw}`).toContain(kw);
      }
    });

    it("退出码的表和细化归属（3、4、6）", () => {
      expect(SKILL_MD).toContain("kh login");
      expect(SKILL_MD).toContain("配对码");
      expect(SKILL_MD).toContain("检查网络和服务端地址");
      expect(SKILL_MD).toContain("重新安装");
    });
  });
});
