import { describe, expect, it } from "vitest";
import { KH_VERSION } from "@kanban-hub/core/version";
import type { CliContext } from "./context";
import { buildProgram } from "./program";

function fakeContext(): CliContext {
  return {
    cwd: "/tmp",
    env: {},
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    stdin: process.stdin,
    isTTY: false,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    platform: "linux",
    hostname: "test-host",
    homeDir: "/home/test-user",
    fetch: (() => {
      throw new Error("不应该在 program 测试里调用 fetch");
    }) as unknown as typeof fetch,
  };
}

function run(args: string[]): { out: string; exitCode: number } {
  let out = "";
  const program = buildProgram(fakeContext())
    .exitOverride()
    .configureOutput({
      writeOut: (s) => {
        out += s;
      },
      writeErr: (s) => {
        out += s;
      },
    });
  try {
    program.parse(args, { from: "user" });
  } catch (e) {
    return { out, exitCode: (e as { exitCode?: number }).exitCode ?? 1 };
  }
  return { out, exitCode: 0 };
}

describe("kh 程序定义", () => {
  it("--version 与 -v 输出 KH_VERSION", () => {
    expect(run(["--version"])).toEqual({ out: `${KH_VERSION}\n`, exitCode: 0 });
    expect(run(["-v"]).out.trim()).toBe(KH_VERSION);
  });

  it("--help 包含中文描述", () => {
    const r = run(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("kanban-hub 命令行");
  });

  it("--agent 是全局选项", () => {
    const r = run(["--help"]);
    expect(r.out).toContain("--agent");
  });
});
