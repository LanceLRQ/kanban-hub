import { describe, expect, it } from "vitest";
import type { ProjectView } from "@kanban-hub/core/api";
import { EXIT, type CliError } from "../errors";
import { defaultProjectName, resolveBindProject } from "./register";

function captureError(fn: () => unknown): CliError {
  try {
    fn();
  } catch (err) {
    return err as CliError;
  }
  throw new Error("期望抛出异常，但没有抛出");
}

function fakeProjectView(id: string, name: string, fingerprint: string | null = null): ProjectView {
  return {
    project: {
      id,
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      name,
      description: "",
      cycle: "development",
      health: "on_track",
      focus: "",
      fingerprint,
      locations: [],
    },
    lastEventAt: null,
    stale: false,
  };
}

describe("defaultProjectName", () => {
  it("取仓库根目录的目录名", () => {
    expect(defaultProjectName("/home/user/projects/kanban-hub")).toBe("kanban-hub");
    expect(defaultProjectName("/home/user/projects/kanban-hub/")).toBe("kanban-hub");
  });
});

describe("resolveBindProject", () => {
  // abcx1 与 abcy1 共享前缀 "abc"（3 位，不够格判定歧义），各自的完整 ID 和 4 位前缀都能唯一定位；
  // abcz111111 与 abcz222222 共享 4 位前缀 "abcz"，专门用来测试歧义分支。
  const uniqueA = fakeProjectView("abcx1111111".slice(0, 10), "项目甲");
  const uniqueB = fakeProjectView("abcy2222222".slice(0, 10), "项目乙");
  const ambiguous1 = fakeProjectView("abcz111111".slice(0, 10), "项目丙");
  const ambiguous2 = fakeProjectView("abcz222222".slice(0, 10), "项目丁");
  const projects: ProjectView[] = [uniqueA, uniqueB, ambiguous1, ambiguous2];

  it("完整 ID 精确匹配", () => {
    const result = resolveBindProject(projects, uniqueA.project.id);
    expect(result.project.name).toBe("项目甲");
  });

  it("唯一前缀能匹配到项目（不区分大小写）", () => {
    const result = resolveBindProject(projects, uniqueB.project.id.slice(0, 4).toUpperCase());
    expect(result.project.name).toBe("项目乙");
  });

  it("前缀少于 4 位是用法错误（退出码 2）", () => {
    const err = captureError(() => resolveBindProject(projects, "abc"));
    expect(err.exitCode).toBe(EXIT.USAGE);
  });

  it("包含非法字符是用法错误（退出码 2）", () => {
    const err = captureError(() => resolveBindProject(projects, "abcd#123"));
    expect(err.exitCode).toBe(EXIT.USAGE);
  });

  it("四位前缀匹配到多个项目时是数据错误（退出码 5），提示里列出候选项目", () => {
    const err = captureError(() => resolveBindProject(projects, "abcz"));
    expect(err.exitCode).toBe(EXIT.DATA);
    expect(err.hint).toContain("项目丙");
    expect(err.hint).toContain("项目丁");
  });

  it("找不到匹配的项目是数据错误（退出码 5）", () => {
    const err = captureError(() => resolveBindProject(projects, "zzzz999999"));
    expect(err.exitCode).toBe(EXIT.DATA);
  });
});
