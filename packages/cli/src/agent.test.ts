import { describe, expect, it } from "vitest";
import { detectAgent, resolveAgent } from "./agent";
import { EXIT } from "./errors";

describe("detectAgent", () => {
  it("CLAUDECODE=1 识别为 claude-code", () => {
    expect(detectAgent({ CLAUDECODE: "1" })).toBe("claude-code");
  });

  it("GEMINI_CLI=1 识别为 gemini-cli", () => {
    expect(detectAgent({ GEMINI_CLI: "1" })).toBe("gemini-cli");
  });

  it("CODEX_SANDBOX 有值识别为 codex", () => {
    expect(detectAgent({ CODEX_SANDBOX: "seatbelt" })).toBe("codex");
  });

  it("CODEX_THREAD_ID 有值识别为 codex", () => {
    expect(detectAgent({ CODEX_THREAD_ID: "thread-1" })).toBe("codex");
  });

  it("OPENCODE=1 识别为 opencode", () => {
    expect(detectAgent({ OPENCODE: "1" })).toBe("opencode");
  });

  it("都没有时返回 null", () => {
    expect(detectAgent({})).toBeNull();
  });

  it("空字符串不算有值", () => {
    expect(detectAgent({ CODEX_SANDBOX: "", CODEX_THREAD_ID: "" })).toBeNull();
  });

  it("多个变量同时存在时按对照表顺序优先：claude-code > gemini-cli > codex > opencode", () => {
    expect(
      detectAgent({
        CLAUDECODE: "1",
        GEMINI_CLI: "1",
        CODEX_SANDBOX: "seatbelt",
        OPENCODE: "1",
      }),
    ).toBe("claude-code");
    expect(detectAgent({ GEMINI_CLI: "1", CODEX_SANDBOX: "seatbelt", OPENCODE: "1" })).toBe("gemini-cli");
    expect(detectAgent({ CODEX_SANDBOX: "seatbelt", OPENCODE: "1" })).toBe("codex");
  });
});

describe("resolveAgent", () => {
  it("--agent 优先于环境变量识别结果", () => {
    expect(resolveAgent("custom-agent", { CLAUDECODE: "1" })).toBe("custom-agent");
  });

  it("没有 --agent 时退回环境变量识别", () => {
    expect(resolveAgent(undefined, { CLAUDECODE: "1" })).toBe("claude-code");
  });

  it("都没有时为 null", () => {
    expect(resolveAgent(undefined, {})).toBeNull();
  });

  it("--agent 超过 50 个字符时抛用法错误", () => {
    const tooLong = "a".repeat(51);
    expect(() => resolveAgent(tooLong, {})).toThrowError(
      expect.objectContaining({ exitCode: EXIT.USAGE }),
    );
  });

  it("--agent 恰好 50 个字符时允许", () => {
    const ok = "a".repeat(50);
    expect(resolveAgent(ok, {})).toBe(ok);
  });

  it("--agent 为空字符串时抛用法错误", () => {
    expect(() => resolveAgent("", {})).toThrowError(expect.objectContaining({ exitCode: EXIT.USAGE }));
  });

  it("--agent 含空格时抛用法错误", () => {
    expect(() => resolveAgent("claude code", {})).toThrowError(expect.objectContaining({ exitCode: EXIT.USAGE }));
  });

  it("--agent 是中文时抛用法错误", () => {
    expect(() => resolveAgent("验收脚本", {})).toThrowError(expect.objectContaining({ exitCode: EXIT.USAGE }));
  });

  it("--agent 含控制字符时抛用法错误", () => {
    expect(() => resolveAgent("a\nb", {})).toThrowError(expect.objectContaining({ exitCode: EXIT.USAGE }));
  });
});
