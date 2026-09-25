import { describe, expect, it } from "vitest";
import { hasActiveFilters } from "./active-filters";

describe("hasActiveFilters", () => {
  it("跨项目时间线：没有任何筛选时为 false", () => {
    expect(hasActiveFilters({})).toBe(false);
  });

  it("跨项目时间线：选中项目筛选时为 true", () => {
    expect(hasActiveFilters({ projectId: "p1" })).toBe(true);
  });

  it("跨项目时间线：选中类型或操作者筛选时为 true", () => {
    expect(hasActiveFilters({ group: "log" })).toBe(true);
    expect(hasActiveFilters({ actor: "web" })).toBe(true);
  });

  it("项目内时间线：固定的 projectId 不算用户主动筛选，没有其他筛选时为 false", () => {
    expect(hasActiveFilters({ projectId: "p1" }, "p1")).toBe(false);
  });

  it("项目内时间线：额外选中类型或操作者筛选时仍为 true", () => {
    expect(hasActiveFilters({ projectId: "p1", group: "log" }, "p1")).toBe(true);
    expect(hasActiveFilters({ projectId: "p1", actor: "web" }, "p1")).toBe(true);
  });
});
