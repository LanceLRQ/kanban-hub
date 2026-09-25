import { describe, expect, it } from "vitest";
import { EXIT, type CliError } from "../errors";
import {
  assertHasSetOption,
  assertSuspendReason,
  containerLabel,
  dedupePaths,
  displayValue,
  parseChecklistIndex,
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

describe("containerLabel", () => {
  it("杂项容器固定显示 misc（即便自己有 code）", () => {
    expect(containerLabel({ kind: "misc", code: "misc" })).toBe("misc");
    expect(containerLabel({ kind: "misc", code: null })).toBe("misc");
  });

  it("有编号的容器显示编号", () => {
    expect(containerLabel({ kind: "phase", code: "M2" })).toBe("M2");
  });

  it("非杂项容器没有编号时给出退化提示，不会误显示成 misc", () => {
    expect(containerLabel({ kind: "phase", code: null })).toBe("(无编号)");
  });
});

describe("displayValue", () => {
  it("null 显示成 (空)", () => {
    expect(displayValue(null)).toBe("(空)");
  });

  it("空串显示成 (空)", () => {
    expect(displayValue("")).toBe("(空)");
  });

  it("非空字符串原样返回", () => {
    expect(displayValue("v1.0")).toBe("v1.0");
  });
});

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
