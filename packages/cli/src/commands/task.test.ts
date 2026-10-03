import { describe, expect, it } from "vitest";
import type { Container, Task } from "@kanban-hub/core/schema";
import { EXIT, type CliError } from "../errors";
import {
  assertHasSetOption,
  assertSuspendReason,
  dedupePaths,
  formatTaskReorder,
  parseChecklistIndex,
  planTaskReorder,
  resolveHumanFlag,
  type SetOptionsInput,
} from "./task";

function captureThrow(fn: () => unknown): CliError {
  try {
    fn();
  } catch (err) {
    return err as CliError;
  }
  throw new Error("期望抛出异常，但没有抛出");
}

describe("dedupePaths", () => {
  it("按先出现顺序去重", () => {
    expect(dedupePaths(["docs/a.md", "docs/b.md", "docs/a.md"])).toEqual(["docs/a.md", "docs/b.md"]);
  });

  it("没有重复时原样返回（顺序不变）", () => {
    expect(dedupePaths(["a", "b"])).toEqual(["a", "b"]);
  });
});

describe("parseChecklistIndex", () => {
  it("合法序号转成从 0 开始的下标", () => {
    expect(parseChecklistIndex("1", 3)).toBe(0);
    expect(parseChecklistIndex("3", 3)).toBe(2);
  });

  it("序号为 0 时抛 CliError(2)", () => {
    const err = captureThrow(() => parseChecklistIndex("0", 3));
    expect(err.exitCode).toBe(EXIT.USAGE);
  });

  it("超出清单长度时抛 CliError(2)", () => {
    const err = captureThrow(() => parseChecklistIndex("4", 3));
    expect(err.exitCode).toBe(EXIT.USAGE);
  });

  it("不是整数时抛 CliError(2)", () => {
    const err = captureThrow(() => parseChecklistIndex("1.5", 3));
    expect(err.exitCode).toBe(EXIT.USAGE);
  });

  it("不是数字时抛 CliError(2)", () => {
    const err = captureThrow(() => parseChecklistIndex("abc", 3));
    expect(err.exitCode).toBe(EXIT.USAGE);
  });

  it("清单为空时任何序号都超出范围", () => {
    const err = captureThrow(() => parseChecklistIndex("1", 0));
    expect(err.exitCode).toBe(EXIT.USAGE);
  });
});

describe("assertHasSetOption", () => {
  const empty: SetOptionsInput = { doc: [] };

  it("什么选项都没给时抛 CliError(2)", () => {
    const err = captureThrow(() => assertHasSetOption(empty));
    expect(err.exitCode).toBe(EXIT.USAGE);
  });

  it("给了 --doc 时不抛", () => {
    expect(() => assertHasSetOption({ ...empty, doc: ["a.md"] })).not.toThrow();
  });

  it("给了 --title 时不抛", () => {
    expect(() => assertHasSetOption({ ...empty, title: "新标题" })).not.toThrow();
  });

  it("给了 --container 时不抛", () => {
    expect(() => assertHasSetOption({ ...empty, container: "M2" })).not.toThrow();
  });
});

describe("assertSuspendReason", () => {
  it("状态改成 suspended 却没给 reason 时抛 CliError(2)", () => {
    const err = captureThrow(() => assertSuspendReason("suspended", undefined));
    expect(err.exitCode).toBe(EXIT.USAGE);
  });

  it("状态改成 suspended 且给了 reason 时不抛", () => {
    expect(() => assertSuspendReason("suspended", "等待外部依赖")).not.toThrow();
  });

  it("状态改成 suspended 但 reason 是空字符串时抛 CliError(2)", () => {
    const err = captureThrow(() => assertSuspendReason("suspended", ""));
    expect(err.exitCode).toBe(EXIT.USAGE);
  });

  it("状态不是 suspended 时，不管有没有 reason 都不抛", () => {
    expect(() => assertSuspendReason("done", undefined)).not.toThrow();
    expect(() => assertSuspendReason(undefined, undefined)).not.toThrow();
  });
});

describe("resolveHumanFlag", () => {
  it("恰好给一个类型时返回对应的 human 值", () => {
    expect(resolveHumanFlag({ decision: "选 A 还是 B" })).toEqual({ kind: "decision", note: "选 A 还是 B" });
    expect(resolveHumanFlag({ verify: "验证一下" })).toEqual({ kind: "verify", note: "验证一下" });
    expect(resolveHumanFlag({ action: "去发布" })).toEqual({ kind: "action", note: "去发布" });
  });

  it("只给 --clear 时返回 null", () => {
    expect(resolveHumanFlag({ clear: true })).toBeNull();
  });

  it("什么都没给时抛 CliError(2)", () => {
    const err = captureThrow(() => resolveHumanFlag({}));
    expect(err.exitCode).toBe(EXIT.USAGE);
  });

  it("同时给两个类型时抛 CliError(2)", () => {
    const err = captureThrow(() => resolveHumanFlag({ decision: "a", verify: "b" }));
    expect(err.exitCode).toBe(EXIT.USAGE);
  });

  it("给了类型又给 --clear 时抛 CliError(2)", () => {
    const err = captureThrow(() => resolveHumanFlag({ decision: "a", clear: true }));
    expect(err.exitCode).toBe(EXIT.USAGE);
  });

  it("给了类型选项但没有说明文字（commander 的可选参数解析成 true）时抛 CliError(2)", () => {
    const err = captureThrow(() => resolveHumanFlag({ decision: true }));
    expect(err.exitCode).toBe(EXIT.USAGE);
  });
});

describe("planTaskReorder / formatTaskReorder", () => {
  const base = { version: 1, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" };
  const containers = [
    { ...base, id: "c1aaaaaaaa", kind: "phase", code: "M2", title: "阶段二", order: 0 },
    { ...base, id: "c2bbbbbbbb", kind: "misc", code: null, title: "杂项", order: 1 },
  ] as unknown as Container[];
  const mk = (id: string, code: string | null, order: number, containerId: string, status = "todo") =>
    ({ ...base, id, code, order, containerId, status, title: `任务${id.slice(0, 2)}` }) as unknown as Task;
  const tasks = [
    mk("a1aaaaaaaa", "1", 0, "c1aaaaaaaa"),
    mk("b2bbbbbbbb", "2", 1, "c1aaaaaaaa", "in_progress"),
    mk("d3dddddddd", null, 2, "c1aaaaaaaa"),
    mk("e4eeeeeeee", null, 0, "c2bbbbbbbb"),
  ];
  const board = { containers, tasks };

  it("解析容器与任务，返回请求体用的 ID 和改前顺序", () => {
    const plan = planTaskReorder(board, "M2", ["M2/2", "#d3dd"]);
    expect(plan.container.id).toBe("c1aaaaaaaa");
    expect(plan.taskIds).toEqual(["b2bbbbbbbb", "d3dddddddd"]);
    expect(plan.before).toEqual(["a1aaaaaaaa", "b2bbbbbbbb", "d3dddddddd"]);
  });

  it("参数重复（写法不同但指向同一任务）时抛 CliError(2)", () => {
    const err = captureThrow(() => planTaskReorder(board, "M2", ["M2/1", "#a1aa"]));
    expect(err.exitCode).toBe(EXIT.USAGE);
  });

  it("任务不属于指定容器时抛 CliError(2)", () => {
    const err = captureThrow(() => planTaskReorder(board, "M2", ["M2/1", "#e4ee"]));
    expect(err.exitCode).toBe(EXIT.USAGE);
  });

  it("裸参数按编号找不到时回退到完整 ID", () => {
    const plan = planTaskReorder(board, "M2", ["b2bbbbbbbb", "a1aaaaaaaa"]);
    expect(plan.taskIds).toEqual(["b2bbbbbbbb", "a1aaaaaaaa"]);
  });

  it("回退解析出的任务不属于该容器时仍抛 CliError(2)", () => {
    const err = captureThrow(() => planTaskReorder(board, "M2", ["e4eeeeeeee"]));
    expect(err.exitCode).toBe(EXIT.USAGE);
    expect(err.message).toContain("不属于");
  });

  it("编号和 ID 都找不到时报容器里没有该编号", () => {
    const err = captureThrow(() => planTaskReorder(board, "M2", ["T9"]));
    expect(err.exitCode).toBe(EXIT.USAGE);
    expect(err.message).toContain("里没有编号为 T9 的任务");
  });

  it("裸编号按指定容器内的任务编号解析", () => {
    const plan = planTaskReorder(board, "M2", ["2", "1"]);
    expect(plan.taskIds).toEqual(["b2bbbbbbbb", "a1aaaaaaaa"]);
  });

  it("裸编号在容器内不存在时抛 CliError(2)，提示里带容器标签", () => {
    const err = captureThrow(() => planTaskReorder(board, "M2", ["9"]));
    expect(err.exitCode).toBe(EXIT.USAGE);
    expect(err.message).toContain("容器 M2 里没有编号为 9 的任务");
  });

  it("“容器/编号”指向别的容器的任务时仍报不属于", () => {
    const boardWithCode = {
      containers,
      tasks: [...tasks.slice(0, 3), { ...tasks[3]!, code: "7" } as Task],
    };
    const err = captureThrow(() => planTaskReorder(boardWithCode, "M2", ["misc/7"]));
    expect(err.exitCode).toBe(EXIT.USAGE);
    expect(err.message).toContain("不属于");
  });

  it("裸编号与 #短ID 指向同一任务按重复处理", () => {
    const err = captureThrow(() => planTaskReorder(board, "M2", ["1", "#a1aa"]));
    expect(err.exitCode).toBe(EXIT.USAGE);
    expect(err.message).toContain("重复");
  });

  it("杂项容器可以重排自己的任务", () => {
    const plan = planTaskReorder(board, "misc", ["#e4ee"]);
    expect(plan.taskIds).toEqual(["e4eeeeeeee"]);
  });

  it("输出：首行、逐行序号 / 短 ID / 编号 / 标题 / 状态", () => {
    const after = [tasks[1]!, tasks[2]!, tasks[0]!];
    const out = formatTaskReorder(board, containers[0]!, ["a1aaaaaaaa", "b2bbbbbbbb", "d3dddddddd"], after);
    const lines = out.split("\n");
    expect(lines[0]).toBe("已重排 M2 的任务顺序：");
    expect(lines[1]).toContain("1.");
    expect(lines[1]).toContain("#b2bb");
    expect(lines[1]).toContain("2");
    expect(lines[1]).toContain("任务b2");
    expect(lines[1]).toContain("进行中");
    expect(lines).toHaveLength(4);
  });

  it("顺序没变时只输出“顺序未变化”", () => {
    const out = formatTaskReorder(board, containers[0]!, ["a1aaaaaaaa", "b2bbbbbbbb", "d3dddddddd"], tasks.slice(0, 3));
    expect(out).toBe("顺序未变化");
  });
});
