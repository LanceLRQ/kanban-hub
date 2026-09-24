import { describe, expect, it } from "vitest";
import { z } from "zod";
import { KH_VERSION } from "@kanban-hub/core/version";
import { ApiError } from "./errors";
import { checkClientVersion, isHttps, isSameOrigin, json, readJson } from "./http";

function req(url: string, init?: RequestInit): Request {
  return new Request(url, init);
}

async function thrownAsync(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error("预期抛出错误");
}

describe("json", () => {
  it("生成 JSON 响应，并带上 X-KH-Version", async () => {
    const res = json({ a: 1 }, { status: 201 });
    expect(res.status).toBe(201);
    expect(res.headers.get("X-KH-Version")).toBe(KH_VERSION);
    expect(await res.json()).toEqual({ a: 1 });
  });

  it("不传 init 时默认 200", () => {
    const res = json({ ok: true });
    expect(res.status).toBe(200);
  });
});

describe("readJson", () => {
  const schema = z.object({ name: z.string() }).strict();

  it("正常请求体解析成功", async () => {
    const r = req("http://localhost/x", {
      method: "POST",
      body: JSON.stringify({ name: "abc" }),
      headers: { "content-type": "application/json" },
    });
    expect(await readJson(r, schema)).toEqual({ name: "abc" });
  });

  it("不是合法 JSON 时报 invalid（400）", async () => {
    const r = req("http://localhost/x", { method: "POST", body: "不是 json" });
    const err = (await thrownAsync(() => readJson(r, schema))) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("invalid");
  });

  it("有未知字段时报 invalid（400，strict）", async () => {
    const r = req("http://localhost/x", { method: "POST", body: JSON.stringify({ name: "abc", extra: 1 }) });
    const err = (await thrownAsync(() => readJson(r, schema))) as { code: string };
    expect(err.code).toBe("invalid");
  });

  it("按 Content-Length 头判断超过上限时报 payload_too_large（413）", async () => {
    const body = JSON.stringify({ name: "x".repeat(100) });
    const r = req("http://localhost/x", {
      method: "POST",
      body,
      headers: { "content-length": String(10 * 1024 * 1024) },
    });
    const err = (await thrownAsync(() => readJson(r, schema, { maxBytes: 10 }))) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("payload_too_large");
  });

  it("按实际读到的字节数判断超过上限时报 payload_too_large（413）", async () => {
    const body = JSON.stringify({ name: "x".repeat(1000) });
    const r = new Request("http://localhost/x", { method: "POST", body });
    // 故意不设置/伪造过小的 content-length，逼迫用实际字节数判断
    const err = (await thrownAsync(() => readJson(r, schema, { maxBytes: 10 }))) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("payload_too_large");
  });
});

describe("checkClientVersion", () => {
  it("没有这个头时返回 null", () => {
    expect(checkClientVersion(null)).toBeNull();
  });

  it("版本兼容时返回 null", () => {
    expect(checkClientVersion(KH_VERSION)).toBeNull();
  });

  it("版本不兼容时返回 upgrade_required，提示走 /setup 的安装命令而不是 kh setup", () => {
    const e = checkClientVersion("9.9.9");
    expect(e).toBeInstanceOf(ApiError);
    expect(e?.code).toBe("upgrade_required");
    expect(e?.message).toContain("9.9.9");
    expect(e?.message).toContain(KH_VERSION);
    expect(e?.message).toContain("/setup/kh.tgz");
    expect(e?.message).not.toContain("kh setup");
  });

  it("格式不对时也返回 upgrade_required，同样提示 /setup 的安装命令", () => {
    const e = checkClientVersion("not-a-version");
    expect(e).toBeInstanceOf(ApiError);
    expect(e?.code).toBe("upgrade_required");
    expect(e?.message).toContain("/setup/kh.tgz");
    expect(e?.message).not.toContain("kh setup");
  });
});

describe("isSameOrigin", () => {
  it("Origin 与 Host 一致时为同源", () => {
    const r = req("http://localhost/x", { headers: { origin: "https://kanban.example.com", host: "kanban.example.com" } });
    expect(isSameOrigin(r)).toBe(true);
  });

  it("端口不同时不算同源", () => {
    const r = req("http://localhost/x", {
      headers: { origin: "https://kanban.example.com:3000", host: "kanban.example.com:8080" },
    });
    expect(isSameOrigin(r)).toBe(false);
  });

  it("按 X-Forwarded-Host 判断（优先于 Host）", () => {
    const r = req("http://localhost/x", {
      headers: { origin: "https://kanban.example.com", host: "127.0.0.1:3000", "x-forwarded-host": "kanban.example.com" },
    });
    expect(isSameOrigin(r)).toBe(true);
  });

  it("KH_PUBLIC_URL 的 host 也算同源", () => {
    const r = req("http://localhost/x", { headers: { origin: "https://public.example.com", host: "127.0.0.1:3000" } });
    expect(isSameOrigin(r, "https://public.example.com")).toBe(true);
  });

  it("Origin 缺失时不算同源", () => {
    const r = req("http://localhost/x", { headers: { host: "kanban.example.com" } });
    expect(isSameOrigin(r)).toBe(false);
  });

  it("Origin 为 null（字面量字符串）时不算同源", () => {
    const r = req("http://localhost/x", { headers: { origin: "null", host: "kanban.example.com" } });
    expect(isSameOrigin(r)).toBe(false);
  });
});

describe("isHttps", () => {
  it("请求本身协议是 https 时为 true", () => {
    expect(isHttps(req("https://kanban.example.com/x"))).toBe(true);
  });

  it("请求本身协议是 http 且没有 X-Forwarded-Proto 时为 false", () => {
    expect(isHttps(req("http://kanban.example.com/x"))).toBe(false);
  });

  it("X-Forwarded-Proto 为 https 时为 true，即使请求本身是 http（反向代理终结 TLS 的场景）", () => {
    const r = req("http://kanban.example.com/x", { headers: { "x-forwarded-proto": "https" } });
    expect(isHttps(r)).toBe(true);
  });

  it("X-Forwarded-Proto 有多段时取第一段", () => {
    const r = req("http://kanban.example.com/x", { headers: { "x-forwarded-proto": "https,http" } });
    expect(isHttps(r)).toBe(true);
  });
});
