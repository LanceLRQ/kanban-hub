import { describe, expect, it } from "vitest";
import { resolvePublicUrl, type RequestOrigin } from "./public-url";

const NONE: RequestOrigin = { forwardedProto: null, forwardedHost: null, host: null };

function fromHost(host: string, extra: Partial<RequestOrigin> = {}): string | null {
  return resolvePublicUrl(null, { ...NONE, host, ...extra });
}

describe("resolvePublicUrl", () => {
  it("配置了地址时直接使用，不理会请求来源", () => {
    expect(resolvePublicUrl("https://kanban.example.com", { forwardedProto: "http", forwardedHost: "x", host: "y" })).toBe(
      "https://kanban.example.com",
    );
  });

  it("转发头优先于 Host", () => {
    expect(fromHost("internal:28970", { forwardedProto: "https", forwardedHost: "kanban.example.com" })).toBe(
      "https://kanban.example.com",
    );
  });

  it("没有转发头时按 Host 推断，协议默认 http", () => {
    expect(fromHost("192.168.1.20:28970")).toBe("http://192.168.1.20:28970");
  });

  it("什么都没有时返回 null", () => {
    expect(resolvePublicUrl(null, NONE)).toBeNull();
  });

  it("多值转发头只取第一个", () => {
    expect(fromHost("x", { forwardedProto: "https, http", forwardedHost: "kanban.example.com, evil.com" })).toBe(
      "https://kanban.example.com",
    );
  });

  it("接受 IPv6 字面量，带端口也行", () => {
    expect(fromHost("[::1]:28970")).toBe("http://[::1]:28970");
    expect(fromHost("[fe80::1]")).toBe("http://[fe80::1]");
  });

  it("协议不是 http/https 时返回 null", () => {
    expect(fromHost("kanban.example.com", { forwardedProto: "ftp" })).toBeNull();
  });

  it.each([
    ["带路径", "kanban.example.com/x"],
    ["带用户信息", "a@b"],
    ["端口超过 5 位", "kanban.example.com:123456"],
    ["端口不是数字", "kanban.example.com:abc"],
    ["含下划线", "kanban_hub.example.com"],
    ["含空格", "192.168.1.20 evil"],
    ["含换行", "kanban.example.com\nX-Injected: 1"],
    ["含控制字符", "kanban\u0007.example.com"],
    ["协议注入", "javascript:alert(1)"],
    ["带查询", "kanban.example.com?x=1"],
  ])("host %s 时返回 null", (_name, host) => {
    expect(fromHost(host)).toBeNull();
    expect(resolvePublicUrl(null, { ...NONE, forwardedHost: host })).toBeNull();
  });
});
