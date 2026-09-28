import { describe, expect, it } from "vitest";
import { EXIT } from "../errors";
import { resolveMachineRef } from "./remote";

const machines = [
  { id: "aaaa1111", name: "笔记本" },
  { id: "aaaa2222", name: "台式机" },
  { id: "bbbb3333", name: "笔记本" },
];

describe("resolveMachineRef", () => {
  it("按机器名精确匹配，唯一命中直接返回", () => {
    expect(resolveMachineRef("台式机", machines)).toEqual(machines[1]);
  });

  it("机器名重复时报用法错误", () => {
    expect(() => resolveMachineRef("笔记本", machines)).toThrowError(
      expect.objectContaining({ name: "CliError", exitCode: EXIT.USAGE }),
    );
  });

  it("按 ID 前缀匹配，唯一命中直接返回", () => {
    expect(resolveMachineRef("aaaa22", machines)).toEqual(machines[1]);
  });

  it("ID 前缀匹配到多个时报用法错误", () => {
    expect(() => resolveMachineRef("aaaa", machines)).toThrowError(
      expect.objectContaining({ name: "CliError", exitCode: EXIT.USAGE }),
    );
  });

  it("找不到匹配时报用法错误", () => {
    expect(() => resolveMachineRef("不存在", machines)).toThrowError(
      expect.objectContaining({ name: "CliError", exitCode: EXIT.USAGE }),
    );
  });
});
