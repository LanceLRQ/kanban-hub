import { describe, expect, it } from "vitest";
import { EXIT, type CliError } from "../errors";
import { buildLogInput } from "./log";

function captureError(fn: () => unknown): CliError {
  try {
    fn();
  } catch (err) {
    return err as CliError;
  }
  throw new Error("期望抛出异常，但没有抛出");
}

describe("buildLogInput", () => {
  it("正文为空（或全是空白）时抛 CliError(2)", () => {
    const err = captureError(() => buildLogInput("   "));
    expect(err.exitCode).toBe(EXIT.USAGE);
  });

  it("正常正文原样返回，并且会 trim", () => {
    const data = buildLogInput("  记一笔  ");
    expect(data.text).toBe("记一笔");
  });
});
