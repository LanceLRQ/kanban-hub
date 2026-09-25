import { describe, expect, it } from "vitest";
import { nextBackoffSeconds } from "./backoff";

describe("nextBackoffSeconds", () => {
  it("从 0 开始按 1、2、4、8…… 翻倍", () => {
    let seconds = 0;
    const sequence: number[] = [];
    for (let i = 0; i < 6; i++) {
      seconds = nextBackoffSeconds(seconds);
      sequence.push(seconds);
    }
    expect(sequence).toEqual([1, 2, 4, 8, 16, 30]);
  });

  it("到达上限后不再增长", () => {
    expect(nextBackoffSeconds(30)).toBe(30);
    expect(nextBackoffSeconds(64)).toBe(30);
  });

  it("负数也当作重新开始", () => {
    expect(nextBackoffSeconds(-1)).toBe(1);
  });
});
