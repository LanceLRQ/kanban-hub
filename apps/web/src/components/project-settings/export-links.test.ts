import { describe, expect, it } from "vitest";
import { exportHref } from "./export-links";

describe("exportHref", () => {
  it("指向带 download=1 的导出接口", () => {
    expect(exportHref("abc0000001", "yaml")).toBe("/api/v1/projects/abc0000001/export?format=yaml&download=1");
    expect(exportHref("abc0000001", "md")).toBe("/api/v1/projects/abc0000001/export?format=md&download=1");
  });
});
