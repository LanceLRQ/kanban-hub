import { describe, expect, it } from "vitest";
import { EXIT, type CliError } from "../errors";
import {
  buildContainerCreateInput,
  buildContainerPatch,
  formatContainerAddedMessage,
  parseTargetDateOption,
} from "./container";

function captureError(fn: () => unknown): CliError {
  try {
    fn();
  } catch (err) {
    return err as CliError;
  }
  throw new Error("期望抛出异常，但没有抛出");
}

describe("parseTargetDateOption", () => {
  it("未传时返回 undefined（不改动字段）", () => {
    expect(parseTargetDateOption(undefined)).toBeUndefined();
  });

  it("空字符串表示清空，返回 null", () => {
    expect(parseTargetDateOption("")).toBeNull();
  });

  it("合法日期原样返回", () => {
    expect(parseTargetDateOption("2026-09-25")).toBe("2026-09-25");
  });

  it("格式不对时抛 CliError(2)", () => {
    const err = captureError(() => parseTargetDateOption("2026/09/25"));
    expect(err.exitCode).toBe(EXIT.USAGE);
  });
});

describe("buildContainerCreateInput", () => {
  it("种类不是 phase/feature 时抛 CliError(2)，提示列出可选值", () => {
    const err = captureError(() => buildContainerCreateInput("misc", "标题", {}));
    expect(err.exitCode).toBe(EXIT.USAGE);
    expect(err.hint).toContain("phase");
    expect(err.hint).toContain("feature");
  });

  it("合法输入整理出请求体", () => {
    const { kind, data } = buildContainerCreateInput("phase", "阶段一", {
      code: "M1",
      version: "v1",
      targetDate: "2026-09-25",
    });
    expect(kind).toBe("phase");
    expect(data).toMatchObject({
      kind: "phase",
      title: "阶段一",
      code: "M1",
      targetVersion: "v1",
      targetDate: "2026-09-25",
    });
  });

  it("不给可选项时请求体里不带对应字段", () => {
    const { data } = buildContainerCreateInput("feature", "某特性", {});
    expect(data).toEqual({ kind: "feature", title: "某特性" });
  });

  it("目标日期格式不对时抛 CliError(2)", () => {
    const err = captureError(() => buildContainerCreateInput("phase", "阶段一", { targetDate: "不是日期" }));
    expect(err.exitCode).toBe(EXIT.USAGE);
  });
});

describe("formatContainerAddedMessage", () => {
  it("有编号时，编号与短 ID 前缀之间用空格分隔", () => {
    expect(formatContainerAddedMessage("feature", "M1", "u85r", "离线同步")).toBe(
      "已新建特性容器 M1（u85r）：离线同步",
    );
  });

  it("没有编号时不显示（无），直接是短 ID 前缀", () => {
    expect(formatContainerAddedMessage("feature", null, "u85r", "离线同步")).toBe(
      "已新建特性容器（u85r）：离线同步",
    );
  });

  it("phase 种类的标签正确", () => {
    expect(formatContainerAddedMessage("phase", null, "abcd", "阶段一")).toBe(
      "已新建阶段容器（abcd）：阶段一",
    );
  });
});

describe("buildContainerPatch", () => {
  it("不给任何选项时抛 CliError(2)", () => {
    const err = captureError(() => buildContainerPatch({}));
    expect(err.exitCode).toBe(EXIT.USAGE);
  });

  it("--status suspended 不给 --reason 时抛 CliError(2)，不发请求", () => {
    const err = captureError(() => buildContainerPatch({ status: "suspended" }));
    expect(err.exitCode).toBe(EXIT.USAGE);
  });

  it("--status suspended --reason \"\" 时抛 CliError(2)，不发请求", () => {
    const err = captureError(() => buildContainerPatch({ status: "suspended", reason: "" }));
    expect(err.exitCode).toBe(EXIT.USAGE);
  });

  it("--status suspended 给了 --reason 时正常整理", () => {
    const patch = buildContainerPatch({ status: "suspended", reason: "等待评审" });
    expect(patch).toEqual({ manualStatus: "suspended", manualReason: "等待评审" });
  });

  it("--status auto 转成 manualStatus: null", () => {
    const patch = buildContainerPatch({ status: "auto" });
    expect(patch).toEqual({ manualStatus: null });
  });

  it("--code 传空字符串表示清空", () => {
    const patch = buildContainerPatch({ code: "" });
    expect(patch).toEqual({ code: null });
  });

  it("--status 取值非法时抛 CliError(2)，提示列出可选值（含 auto）", () => {
    const err = captureError(() => buildContainerPatch({ status: "bogus" }));
    expect(err.exitCode).toBe(EXIT.USAGE);
    expect(err.hint).toContain("auto");
  });

  it("多个选项一起给出时都整理进请求体", () => {
    const patch = buildContainerPatch({ title: "新标题", version: "v2", targetDate: "" });
    expect(patch).toEqual({ title: "新标题", targetVersion: "v2", targetDate: null });
  });
});
