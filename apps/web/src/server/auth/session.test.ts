import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  buildSessionCookie,
  clearSessionCookie,
  readCookie,
  signSession,
  verifySession,
  type SessionPayload,
} from "./session";

const SECRET = "s3cret-test-key";

describe("SESSION_TTL_MS", () => {
  it("为 30 天", () => {
    expect(SESSION_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});

describe("signSession / verifySession", () => {
  const now = Date.parse("2026-09-24T00:00:00.000Z");
  const payload: SessionPayload = { userId: "u1", sessionVersion: 0, expiresAt: now + SESSION_TTL_MS };

  it("能签出来也能校验通过", () => {
    const token = signSession(payload, SECRET);
    expect(verifySession(token, SECRET, now)).toEqual(payload);
  });

  it("篡改 payload 后校验失败", () => {
    const token = signSession(payload, SECRET);
    const [, sig] = token.split(".");
    const tampered = Buffer.from(JSON.stringify({ ...payload, userId: "u2" })).toString("base64url");
    expect(verifySession(`${tampered}.${sig}`, SECRET, now)).toBeNull();
  });

  it("篡改签名后校验失败", () => {
    const token = signSession(payload, SECRET);
    const [payloadB64, sig] = token.split(".");
    if (payloadB64 === undefined || sig === undefined) throw new Error("测试前置条件不满足：token 格式异常");
    const tamperedSig = sig.slice(0, -1) + (sig.at(-1) === "a" ? "b" : "a");
    expect(verifySession(`${payloadB64}.${tamperedSig}`, SECRET, now)).toBeNull();
  });

  it("换一个 secret 校验失败", () => {
    const token = signSession(payload, SECRET);
    expect(verifySession(token, "another-secret", now)).toBeNull();
  });

  it("已过期返回 null", () => {
    const expired = signSession({ ...payload, expiresAt: now - 1 }, SECRET);
    expect(verifySession(expired, SECRET, now)).toBeNull();
  });

  it("缺少分隔点返回 null", () => {
    expect(verifySession("not-a-valid-token", SECRET, now)).toBeNull();
    expect(verifySession("", SECRET, now)).toBeNull();
  });

  it("payload 不是 JSON 时返回 null", () => {
    const badPayloadB64 = Buffer.from("not json", "utf8").toString("base64url");
    const sig = createHmac("sha256", SECRET).update(badPayloadB64).digest("base64url");
    expect(verifySession(`${badPayloadB64}.${sig}`, SECRET, now)).toBeNull();
  });
});

describe("buildSessionCookie", () => {
  it("包含 HttpOnly、SameSite=Strict、Path=/ 和 Max-Age", () => {
    const cookie = buildSessionCookie("abc.def", { secure: false, maxAgeSec: 100 });
    expect(cookie).toContain(`${SESSION_COOKIE}=abc.def`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=100");
    expect(cookie).not.toContain("Secure");
  });

  it("secure 为真时带 Secure", () => {
    expect(buildSessionCookie("abc.def", { secure: true, maxAgeSec: 100 })).toContain("Secure");
  });
});

describe("clearSessionCookie", () => {
  it("Max-Age=0，且值为空", () => {
    const cookie = clearSessionCookie({ secure: false });
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain(`${SESSION_COOKIE}=;`);
  });

  it("secure 为真时带 Secure", () => {
    expect(clearSessionCookie({ secure: true })).toContain("Secure");
  });
});

describe("readCookie", () => {
  it("能从多个 cookie 里取出目标", () => {
    const header = `foo=bar; ${SESSION_COOKIE}=abc.def; baz=qux`;
    expect(readCookie(header, SESSION_COOKIE)).toBe("abc.def");
  });

  it("大小写敏感", () => {
    const header = `${SESSION_COOKIE.toUpperCase()}=abc.def`;
    expect(readCookie(header, SESSION_COOKIE)).toBeNull();
  });

  it("目标不存在时返回 null", () => {
    expect(readCookie("foo=bar", SESSION_COOKIE)).toBeNull();
    expect(readCookie(null, SESSION_COOKIE)).toBeNull();
    expect(readCookie("", SESSION_COOKIE)).toBeNull();
  });
});
