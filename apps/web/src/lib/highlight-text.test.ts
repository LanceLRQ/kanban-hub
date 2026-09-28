import { describe, expect, it } from "vitest";
import { wrapAsFencedCode } from "./highlight-text";

describe("wrapAsFencedCode", () => {
  it("按扩展名取语言，作为围栏信息串", () => {
    const wrapped = wrapAsFencedCode("const a = 1;\n", "a.ts");
    expect(wrapped.startsWith("```ts\n")).toBe(true);
    expect(wrapped).toContain("const a = 1;");
  });

  it("没有扩展名时围栏语言留空", () => {
    const wrapped = wrapAsFencedCode("hello", "LICENSE");
    expect(wrapped.startsWith("```\n")).toBe(true);
  });

  it("内容本身带反引号时，围栏用更多反引号，不会被内容提前截断", () => {
    const wrapped = wrapAsFencedCode("code with ``` inside", "a.txt");
    const fenceMatch = /^`+/.exec(wrapped);
    expect(fenceMatch![0].length).toBeGreaterThan(3);
    expect(wrapped).toContain("code with ``` inside");
  });

  it("没有结尾换行的内容会补一个，围栏另起一行", () => {
    const wrapped = wrapAsFencedCode("no newline", "LICENSE");
    expect(wrapped).toBe("```\nno newline\n```\n");
  });
});
