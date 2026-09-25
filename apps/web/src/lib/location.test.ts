import { describe, expect, it } from "vitest";
import type { GitState, Location } from "@kanban-hub/core/schema";
import { makeProject } from "@kanban-hub/core/test-fixtures";
import { locationSummary, primaryLocation } from "./location";

const gitState: GitState = {
  branch: "main",
  head: "abc123",
  headSubject: "提交说明",
  headAt: "2026-09-20T00:00:00.000Z",
  dirtyCount: 2,
  ahead: 1,
  behind: 3,
};

function makeLocation(overrides: Partial<Location> = {}): Location {
  return {
    machineId: "m0000000001",
    path: "/repo",
    lastSyncAt: null,
    sync: null,
    git: null,
    skippedFiles: [],
    ...overrides,
  };
}

describe("primaryLocation", () => {
  it("没有位置时为 null", () => {
    expect(primaryLocation(makeProject({ locations: [] }))).toBeNull();
  });

  it("取 lastSyncAt 最近的那个位置", () => {
    const older = makeLocation({ machineId: "m0000000001", lastSyncAt: "2026-09-20T00:00:00.000Z" });
    const newer = makeLocation({ machineId: "m0000000002", lastSyncAt: "2026-09-24T00:00:00.000Z" });
    expect(primaryLocation(makeProject({ locations: [older, newer] }))).toBe(newer);
  });

  it("都没同步过时，取最后登记的位置（数组末尾）", () => {
    const first = makeLocation({ machineId: "m0000000001" });
    const second = makeLocation({ machineId: "m0000000002" });
    expect(primaryLocation(makeProject({ locations: [first, second] }))).toBe(second);
  });
});

describe("locationSummary", () => {
  it("有完整 git 信息和同步时间时，字段都不是 null", () => {
    const location = makeLocation({ git: gitState, lastSyncAt: "2026-09-24T11:00:00.000Z" });
    const now = new Date("2026-09-24T12:00:00.000Z");
    expect(locationSummary(location, "我的 Mac", now)).toEqual({
      machineName: "我的 Mac",
      path: "/repo",
      branch: "main",
      ahead: 1,
      behind: 3,
      dirtyCount: 2,
      syncedAt: "1 小时前",
    });
  });

  it("缺 git 信息时，对应字段为 null", () => {
    const location = makeLocation({ git: null, lastSyncAt: "2026-09-24T11:00:00.000Z" });
    const now = new Date("2026-09-24T12:00:00.000Z");
    const summary = locationSummary(location, "我的 Mac", now);
    expect(summary.branch).toBeNull();
    expect(summary.ahead).toBeNull();
    expect(summary.behind).toBeNull();
    expect(summary.dirtyCount).toBeNull();
  });

  it("从未同步过时，syncedAt 为 null", () => {
    const location = makeLocation({ git: gitState, lastSyncAt: null });
    const summary = locationSummary(location, "我的 Mac", new Date("2026-09-24T12:00:00.000Z"));
    expect(summary.syncedAt).toBeNull();
  });
});
