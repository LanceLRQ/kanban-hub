import { describe, expect, it } from "vitest";
import { commitMessage, commitScope, commitSummary } from "./commit";

describe("commitScope", () => {
  it("命令行带机器名，网页不带", () => {
    expect(commitScope("cli", "mac")).toBe("cli(mac)");
    expect(commitScope("cli", null)).toBe("cli(未知机器)");
    expect(commitScope("web", null)).toBe("web");
  });
});

describe("commitSummary", () => {
  it("同一类事件合并计数", () => {
    expect(commitSummary(["task.status_changed", "task.status_changed", "task.status_changed"])).toBe("3 项任务状态变更");
  });

  it("多类事件按数量从多到少，数量相同时按首次出现的顺序", () => {
    expect(commitSummary(["log", "task.created", "task.created"])).toBe("2 项新建任务、1 项日志");
  });

  it("超过 3 类时只列前 3 类", () => {
    expect(commitSummary(["log", "task.created", "task.updated", "project.updated"])).toBe(
      "1 项日志、1 项新建任务、1 项任务更新 等",
    );
  });

  it("没有事件时写“数据更新”", () => {
    expect(commitSummary([])).toBe("数据更新");
  });
});

describe("commitMessage", () => {
  it("来源加汇总", () => {
    expect(commitMessage("cli(mac)", ["task.status_changed"])).toBe("cli(mac): 1 项任务状态变更");
  });
});
