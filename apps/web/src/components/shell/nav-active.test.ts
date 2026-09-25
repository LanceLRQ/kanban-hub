import { describe, expect, it } from "vitest";
import { resolveActiveNavHref } from "./nav-active";

describe("resolveActiveNavHref", () => {
  it("根路径高亮总览", () => {
    expect(resolveActiveNavHref("/")).toBe("/");
  });

  it("项目页（/p/*）高亮总览", () => {
    expect(resolveActiveNavHref("/p/proj1")).toBe("/");
    expect(resolveActiveNavHref("/p/proj1/timeline")).toBe("/");
    expect(resolveActiveNavHref("/p/proj1/settings")).toBe("/");
  });

  it("全局时间线高亮时间线", () => {
    expect(resolveActiveNavHref("/timeline")).toBe("/timeline");
    expect(resolveActiveNavHref("/timeline/x")).toBe("/timeline");
  });

  it("设置页高亮设置", () => {
    expect(resolveActiveNavHref("/settings")).toBe("/settings");
    expect(resolveActiveNavHref("/settings/x")).toBe("/settings");
  });

  it("接入引导（/setup）也高亮设置", () => {
    expect(resolveActiveNavHref("/setup")).toBe("/settings");
    expect(resolveActiveNavHref("/setup/agent")).toBe("/settings");
  });

  it("无法识别的路径退回总览", () => {
    expect(resolveActiveNavHref("/anything-else")).toBe("/");
  });
});
