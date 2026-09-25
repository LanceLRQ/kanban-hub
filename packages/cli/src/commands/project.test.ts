import { describe, expect, it } from "vitest";
import { EXIT, type CliError } from "../errors";
import { buildProjectPatch } from "./project";

function captureError(fn: () => unknown): CliError {
  try {
    fn();
  } catch (err) {
    return err as CliError;
  }
  throw new Error("期望抛出异常，但没有抛出");
}

describe("buildProjectPatch", () => {
  it("不给任何选项时抛 CliError(2)", () => {
    const err = captureError(() => buildProjectPatch({}));
    expect(err.exitCode).toBe(EXIT.USAGE);
  });

  it("--cycle 取值非法时抛 CliError(2)，提示列出可选值", () => {
    const err = captureError(() => buildProjectPatch({ cycle: "bogus" }));
    expect(err.exitCode).toBe(EXIT.USAGE);
    expect(err.hint).toContain("development");
  });

  it("--health 取值非法时抛 CliError(2)，提示列出可选值", () => {
    const err = captureError(() => buildProjectPatch({ health: "bogus" }));
    expect(err.exitCode).toBe(EXIT.USAGE);
    expect(err.hint).toContain("at_risk");
  });

  it("合法选项整理成请求体", () => {
    const patch = buildProjectPatch({ cycle: "development", health: "at_risk", focus: "重构存储层" });
    expect(patch).toEqual({ cycle: "development", health: "at_risk", focus: "重构存储层" });
  });

  it("只给一个选项时，请求体里只有那一个字段", () => {
    const patch = buildProjectPatch({ focus: "阶段二" });
    expect(patch).toEqual({ focus: "阶段二" });
  });

  it("--focus 传空字符串合法（清空焦点）", () => {
    const patch = buildProjectPatch({ focus: "" });
    expect(patch).toEqual({ focus: "" });
  });
});
