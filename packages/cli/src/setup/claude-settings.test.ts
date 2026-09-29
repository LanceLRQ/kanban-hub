import { describe, expect, it } from "vitest";
import { EXIT, type CliError } from "../errors";
import { HOOK_COMMANDS, HOOK_TIMEOUT_SECONDS, mergeClaudeHooks } from "./claude-settings";

function captureError(fn: () => unknown): CliError {
  try {
    fn();
  } catch (err) {
    return err as CliError;
  }
  throw new Error("期望抛出异常，但没有抛出");
}

const OUR_GROUP = (event: "SessionStart" | "Stop") => ({
  hooks: [{ type: "command", command: HOOK_COMMANDS[event], timeout: HOOK_TIMEOUT_SECONDS }],
});

describe("mergeClaudeHooks 安装", () => {
  it("空对象：两个事件各新增一个组", () => {
    const { next, added, removed } = mergeClaudeHooks({}, "install");
    expect(added).toEqual(["SessionStart", "Stop"]);
    expect(removed).toEqual([]);
    expect(next).toEqual({
      hooks: {
        SessionStart: [OUR_GROUP("SessionStart")],
        Stop: [OUR_GROUP("Stop")],
      },
    });
  });

  it("没有 hooks 字段：新增 hooks，原有其他顶层字段不变", () => {
    const { next } = mergeClaudeHooks({ theme: "dark" }, "install");
    expect(next.theme).toBe("dark");
    expect(next.hooks).toBeDefined();
  });

  it("hooks 里已有其他事件：原样保留，不校验其内部结构", () => {
    const other = { PreToolUse: "不是数组也不校验" };
    const { next } = mergeClaudeHooks({ hooks: other }, "install");
    expect((next.hooks as Record<string, unknown>).PreToolUse).toBe("不是数组也不校验");
  });

  it("同一事件下已有别的组（含带 matcher 的组）：原有内容逐字不变，新组追加在后面", () => {
    const existingGroup = { matcher: "foo", hooks: [{ type: "command", command: "other-tool" }] };
    const settings = { hooks: { SessionStart: [existingGroup] } };
    const { next } = mergeClaudeHooks(settings, "install");
    const groups = (next.hooks as Record<string, unknown[]>).SessionStart!;
    expect(groups[0]).toEqual(existingGroup);
    expect(groups[1]).toEqual(OUR_GROUP("SessionStart"));
  });

  it("已安装时不重复追加", () => {
    const settings = { hooks: { SessionStart: [OUR_GROUP("SessionStart")], Stop: [OUR_GROUP("Stop")] } };
    const { next, added } = mergeClaudeHooks(settings, "install");
    expect(added).toEqual([]);
    expect(next).toEqual(settings);
  });

  it("已安装但 timeout 不同：不改动这个条目", () => {
    const differentTimeout = { hooks: [{ type: "command", command: HOOK_COMMANDS.SessionStart, timeout: 30 }] };
    const settings = { hooks: { SessionStart: [differentTimeout], Stop: [OUR_GROUP("Stop")] } };
    const { next, added } = mergeClaudeHooks(settings, "install");
    expect(added).toEqual([]);
    expect(next).toEqual(settings);
  });

  it("command 两端有空白也算已安装", () => {
    const withSpace = { hooks: [{ type: "command", command: `  ${HOOK_COMMANDS.Stop}  ` }] };
    const settings = { hooks: { Stop: [withSpace] } };
    const { added } = mergeClaudeHooks(settings, "install");
    expect(added).toEqual(["SessionStart"]);
  });
});

describe("mergeClaudeHooks 卸载", () => {
  it("只移除本工具的条目，组里还有别的条目时保留组", () => {
    const otherEntry = { type: "command", command: "other-tool" };
    const settings = {
      hooks: { SessionStart: [{ hooks: [otherEntry, { type: "command", command: HOOK_COMMANDS.SessionStart }] }] },
    };
    const { next, removed } = mergeClaudeHooks(settings, "uninstall");
    expect(removed).toEqual(["SessionStart"]);
    expect((next.hooks as Record<string, unknown[]>).SessionStart).toEqual([{ hooks: [otherEntry] }]);
  });

  it("组里没有别的条目：删掉这个组", () => {
    const settings = { hooks: { SessionStart: [OUR_GROUP("SessionStart"), { matcher: "x", hooks: [{ command: "y" }] }] } };
    const { next } = mergeClaudeHooks(settings, "uninstall");
    expect((next.hooks as Record<string, unknown[]>).SessionStart).toEqual([{ matcher: "x", hooks: [{ command: "y" }] }]);
  });

  it("事件数组空了：删掉这个事件，其他事件保留", () => {
    const other = { hooks: [{ type: "command", command: "other-tool" }] };
    const settings = { hooks: { SessionStart: [OUR_GROUP("SessionStart")], Stop: [other] } };
    const { next } = mergeClaudeHooks(settings, "uninstall");
    expect(next.hooks).toEqual({ Stop: [other] });
  });

  it("hooks 空了：删掉 hooks 本身", () => {
    const settings = { hooks: { SessionStart: [OUR_GROUP("SessionStart")], Stop: [OUR_GROUP("Stop")] } };
    const { next } = mergeClaudeHooks(settings, "uninstall");
    expect("hooks" in next).toBe(false);
  });

  it("hooks 空了但还有其他顶层字段：其他字段保留", () => {
    const settings = { theme: "dark", hooks: { SessionStart: [OUR_GROUP("SessionStart")] } };
    const { next } = mergeClaudeHooks(settings, "uninstall");
    expect(next).toEqual({ theme: "dark" });
  });

  it("本来就没装：什么都不变", () => {
    const { next, removed } = mergeClaudeHooks({}, "uninstall");
    expect(removed).toEqual([]);
    expect(next).toEqual({});
  });
});

describe("mergeClaudeHooks 结构校验", () => {
  const cases: { name: string; settings: unknown }[] = [
    { name: "顶层是数组", settings: [] },
    { name: "hooks 是字符串", settings: { hooks: "x" } },
    { name: "事件的值不是数组", settings: { hooks: { SessionStart: "x" } } },
    { name: "组不是对象", settings: { hooks: { SessionStart: ["x"] } } },
    { name: "组的 hooks 不是数组", settings: { hooks: { SessionStart: [{ hooks: "x" }] } } },
    { name: "条目不是对象", settings: { hooks: { SessionStart: [{ hooks: ["x"] }] } } },
    { name: "command 是数字", settings: { hooks: { SessionStart: [{ hooks: [{ command: 1 }] }] } } },
  ];

  for (const { name, settings } of cases) {
    it(`${name}（安装）：报数据错误（5）`, () => {
      const err = captureError(() => mergeClaudeHooks(settings, "install"));
      expect(err.exitCode).toBe(EXIT.DATA);
    });

    it(`${name}（卸载）：报数据错误（5）`, () => {
      const err = captureError(() => mergeClaudeHooks(settings, "uninstall"));
      expect(err.exitCode).toBe(EXIT.DATA);
    });
  }

  it("错误信息指出具体路径", () => {
    const err = captureError(() =>
      mergeClaudeHooks({ hooks: { SessionStart: [{ hooks: "x" }], Stop: [{ hooks: [{ command: 1 }]  }] } }, "install"),
    );
    expect(err.message).toContain("hooks.SessionStart[0].hooks");
  });
});
