import { describe, expect, it } from "vitest";
import { nextMachineName } from "./rename-button";

describe("nextMachineName", () => {
  it("去掉首尾空白后返回新名称", () => {
    expect(nextMachineName("旧名字", "  书房的 Mac ")).toBe("书房的 Mac");
  });

  it("与当前名称相同（含只差首尾空白）时不用提交", () => {
    expect(nextMachineName("书房的 Mac", "书房的 Mac")).toBeNull();
    expect(nextMachineName("书房的 Mac", " 书房的 Mac ")).toBeNull();
  });

  it("只有空白时报空", () => {
    expect(nextMachineName("书房的 Mac", "   ")).toBe("empty");
  });
});
