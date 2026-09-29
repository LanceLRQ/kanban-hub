import { describe, expect, it } from "vitest";
import { resolveActiveNavHref } from "./nav-active";

describe("resolveActiveNavHref", () => {
  it("首页（待你处理）不在顶栏导航里，没有高亮项", () => {
    expect(resolveActiveNavHref("/")).toBeNull();
  });

  it("项目列表高亮项目", () => {
    expect(resolveActiveNavHref("/projects")).toBe("/projects");
  });

  it("项目页（/p/*）也高亮项目", () => {
    expect(resolveActiveNavHref("/p/proj1")).toBe("/projects");
    expect(resolveActiveNavHref("/p/proj1/timeline")).toBe("/projects");
    expect(resolveActiveNavHref("/p/proj1/settings")).toBe("/projects");
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

  it("无法识别的路径没有高亮项", () => {
    expect(resolveActiveNavHref("/anything-else")).toBeNull();
    expect(resolveActiveNavHref("/projectsx")).toBeNull();
  });
});
