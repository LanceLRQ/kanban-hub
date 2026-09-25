import { describe, expect, it } from "vitest";
import { CliError, EXIT } from "./errors";

describe("EXIT", () => {
  it("枚举了规格约定的退出码", () => {
    expect(EXIT).toEqual({
      OK: 0,
      UNEXPECTED: 1,
      USAGE: 2,
      AUTH: 3,
      UNREACHABLE: 4,
      DATA: 5,
      INCOMPATIBLE: 6,
    });
  });
});

describe("CliError", () => {
  it("携带退出码、消息与可选提示", () => {
    const err = new CliError(EXIT.DATA, "找不到任务", "检查任务引用是否正确");
    expect(err).toBeInstanceOf(Error);
    expect(err.exitCode).toBe(EXIT.DATA);
    expect(err.message).toBe("找不到任务");
    expect(err.hint).toBe("检查任务引用是否正确");
  });

  it("hint 是可选的", () => {
    const err = new CliError(EXIT.UNEXPECTED, "出错了");
    expect(err.hint).toBeUndefined();
  });
});
