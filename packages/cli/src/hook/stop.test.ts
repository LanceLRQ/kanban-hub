import { describe, expect, it, vi } from "vitest";
import type { RepoChanges } from "./changes";
import type { SessionMarker } from "./marker";
import { shouldRemind, STOP_REMINDER, type ReminderInput } from "./stop";

const STARTED_AT = "2026-09-29T10:00:00.000Z";

function marker(overrides: Partial<SessionMarker> = {}): SessionMarker {
  return {
    sessionId: "s1",
    projectId: "p000000001",
    root: "/repo",
    worktree: "/repo",
    startedAt: STARTED_AT,
    head: "a".repeat(40),
    dirty: "d".repeat(64),
    reminded: false,
    ...overrides,
  };
}

function input(overrides: Partial<ReminderInput> = {}, changes: RepoChanges = { head: "b".repeat(40), dirty: "d".repeat(64) }) {
  const currentChanges = vi.fn(async () => changes);
  const lastReport = vi.fn(async (): Promise<Date | null> => null);
  const value: ReminderInput = {
    marker: marker(),
    projectId: "p000000001",
    stopHookActive: false,
    lastReport,
    currentChanges,
    ...overrides,
  };
  return { value, currentChanges: (value.currentChanges as typeof currentChanges), lastReport: value.lastReport as typeof lastReport };
}

describe("shouldRemind", () => {
  it("四条全部满足：提醒", async () => {
    const { value, currentChanges } = input();
    expect(await shouldRemind(value)).toBe(true);
    expect(currentChanges).toHaveBeenCalledWith(value.marker);
  });

  it("没有标记、已提醒过、标记属于别的项目：不提醒，也不读上报时间、不算改动指纹", async () => {
    for (const m of [null, marker({ reminded: true }), marker({ projectId: "p000000002" })]) {
      const { value, currentChanges, lastReport } = input({ marker: m });
      expect(await shouldRemind(value)).toBe(false);
      expect(lastReport).not.toHaveBeenCalled();
      expect(currentChanges).not.toHaveBeenCalled();
    }
  });

  it("stop_hook_active 为 true：不提醒，不读上报时间、不算改动指纹", async () => {
    const { value, currentChanges, lastReport } = input({ stopHookActive: true });
    expect(await shouldRemind(value)).toBe(false);
    expect(lastReport).not.toHaveBeenCalled();
    expect(currentChanges).not.toHaveBeenCalled();
  });

  it("会话开始后上报过：不提醒，不算改动指纹；会话开始前的上报不算", async () => {
    const after = input({ lastReport: vi.fn(async () => new Date("2026-09-29T10:00:01.000Z")) });
    expect(await shouldRemind(after.value)).toBe(false);
    expect(after.currentChanges).not.toHaveBeenCalled();

    const before = input({ lastReport: vi.fn(async () => new Date("2026-09-29T09:59:59.000Z")) });
    expect(await shouldRemind(before.value)).toBe(true);
  });

  it("head 与 dirty 都和会话开始时相同：不提醒；只有 dirty 变了：提醒", async () => {
    const same = input({}, { head: "a".repeat(40), dirty: "d".repeat(64) });
    expect(await shouldRemind(same.value)).toBe(false);
    const dirtyChanged = input({}, { head: "a".repeat(40), dirty: "e".repeat(64) });
    expect(await shouldRemind(dirtyChanged.value)).toBe(true);
  });

  it("不是 git 仓库（两边都是 null）：永远不提醒", async () => {
    const { value } = input({ marker: marker({ head: null, dirty: null }) }, { head: null, dirty: null });
    expect(await shouldRemind(value)).toBe(false);
  });
});

describe("STOP_REMINDER", () => {
  it("说明改动了仓库、还没上报，指向 kh task set / kh task add / kh log，允许直接结束；不以“错误：”开头", () => {
    expect(STOP_REMINDER).toContain("kh task set");
    expect(STOP_REMINDER).toContain("kh task add");
    expect(STOP_REMINDER).toContain("kh log");
    expect(STOP_REMINDER).toContain("可以直接结束");
    expect(STOP_REMINDER.startsWith("错误：")).toBe(false);
    expect(STOP_REMINDER.endsWith("\n")).toBe(true);
  });
});
