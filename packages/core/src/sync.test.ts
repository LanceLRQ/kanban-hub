import { describe, expect, it } from "vitest";
import { SYNC_ALWAYS_EXCLUDE, SYNC_DEFAULT_MAX_FILE_SIZE, SYNC_MAX_FILE_SIZE_LIMIT } from "./sync";

describe("同步常量", () => {
  it("默认上限是 5MB", () => {
    expect(SYNC_DEFAULT_MAX_FILE_SIZE).toBe(5 * 1024 * 1024);
  });

  it("硬上限是 20MB", () => {
    expect(SYNC_MAX_FILE_SIZE_LIMIT).toBe(20 * 1024 * 1024);
  });

  it("默认上限小于硬上限", () => {
    expect(SYNC_DEFAULT_MAX_FILE_SIZE).toBeLessThan(SYNC_MAX_FILE_SIZE_LIMIT);
  });

  it("始终排除 node_modules、.git、.next", () => {
    expect(SYNC_ALWAYS_EXCLUDE).toEqual(["**/node_modules/**", "**/.git/**", "**/.next/**"]);
  });
});
