import { describe, expect, it } from "vitest";
import { resolveContainerRef, resolveTaskRef } from "./refs";
import { makeBoard, makeContainer, makeTask } from "./test-fixtures";

const M1 = makeContainer({ id: "c000000001", code: "M1", title: "阶段一" });
const M2 = makeContainer({ id: "c000000002", code: "M2", title: "阶段二", order: 2 });
const board = makeBoard(
  [M1, M2],
  [
    makeTask({ id: "k3v9x2m7qa", containerId: M2.id, code: "2.3" }),
    makeTask({ id: "k3v9y1aaaa", containerId: M2.id, code: "2.4" }),
    makeTask({ id: "abcd123456", containerId: "c000000000", code: "1" }),
  ],
);

describe("resolveContainerRef", () => {
  it.each([
    ["misc", "c000000000"],
    ["MISC", "c000000000"],
    ["M2", "c000000002"],
    ["m2", "c000000002"],
    ["c000000001", "c000000001"],
  ])("%s → %s", (ref, id) => {
    expect(resolveContainerRef(board.containers, ref)).toEqual({ ok: true, id });
  });

  it("ID 前缀匹配到多个容器时报歧义", () => {
    expect(resolveContainerRef(board.containers, "c0000")).toMatchObject({ ok: false, reason: "ambiguous" });
  });

  it("找不到时报 not_found，并写出原文", () => {
    expect(resolveContainerRef(board.containers, "M9")).toEqual({ ok: false, reason: "not_found", message: "找不到容器“M9”" });
  });

  it("空写法无效", () => {
    expect(resolveContainerRef(board.containers, " ")).toMatchObject({ ok: false, reason: "invalid" });
  });
});

describe("resolveTaskRef", () => {
  it.each([
    ["#k3v9x", "k3v9x2m7qa"],
    ["#K3V9Y", "k3v9y1aaaa"],
    ["M2/2.3", "k3v9x2m7qa"],
    ["m2/2.4", "k3v9y1aaaa"],
    ["misc/1", "abcd123456"],
    ["abcd123456", "abcd123456"],
  ])("%s → %s", (ref, id) => {
    expect(resolveTaskRef(board, ref)).toEqual({ ok: true, id });
  });

  it("短 ID 匹配到多个任务时，列出能区分它们的短 ID", () => {
    const r = resolveTaskRef(board, "#k3v9");
    expect(r).toMatchObject({ ok: false, reason: "ambiguous" });
    expect(!r.ok && r.message).toContain("#k3v9x");
    expect(!r.ok && r.message).toContain("#k3v9y");
  });

  it("短 ID 不足 4 位时无效", () => {
    expect(resolveTaskRef(board, "#k3v")).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("容器找不到时报容器的错误", () => {
    expect(resolveTaskRef(board, "M9/1")).toEqual({ ok: false, reason: "not_found", message: "找不到容器“M9”" });
  });

  it("容器里没有这个编号时报 not_found", () => {
    expect(resolveTaskRef(board, "M2/9.9")).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("无法识别的写法给出正确写法的提示", () => {
    const r = resolveTaskRef(board, "2.3");
    expect(r).toMatchObject({ ok: false, reason: "invalid" });
    expect(!r.ok && r.message).toContain("M2/2.3");
  });
});
