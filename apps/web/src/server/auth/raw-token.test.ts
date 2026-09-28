import { describe, expect, it } from "vitest";
import { rawTokenSecret, signRawToken, verifyRawToken } from "./raw-token";

const SESSION_SECRET = "session-secret-for-test";

describe("raw-token", () => {
  it("签发后能校验，取回项目 ID 与机器 ID", () => {
    const secret = rawTokenSecret(SESSION_SECRET);
    const now = new Date("2026-09-28T00:00:00.000Z");
    const { token } = signRawToken(secret, { projectId: "p1", machineId: "m1" }, now);
    expect(verifyRawToken(secret, token, now.getTime())).toEqual({ projectId: "p1", machineId: "m1" });
  });

  it("篡改负载返回 null", () => {
    const secret = rawTokenSecret(SESSION_SECRET);
    const now = new Date("2026-09-28T00:00:00.000Z");
    const { token } = signRawToken(secret, { projectId: "p1", machineId: "m1" }, now);
    const [payloadB64, sig] = token.split(".");
    const tampered = JSON.parse(Buffer.from(payloadB64!, "base64url").toString("utf8")) as Record<string, unknown>;
    tampered.machineId = "m2";
    const tamperedPayload = Buffer.from(JSON.stringify(tampered), "utf8").toString("base64url");
    expect(verifyRawToken(secret, `${tamperedPayload}.${sig}`, now.getTime())).toBeNull();
  });

  it("篡改签名返回 null", () => {
    const secret = rawTokenSecret(SESSION_SECRET);
    const now = new Date("2026-09-28T00:00:00.000Z");
    const { token } = signRawToken(secret, { projectId: "p1", machineId: "m1" }, now);
    const [payloadB64] = token.split(".");
    expect(verifyRawToken(secret, `${payloadB64}.deadbeef`, now.getTime())).toBeNull();
  });

  it("过期返回 expired", () => {
    const secret = rawTokenSecret(SESSION_SECRET);
    const now = new Date("2026-09-28T00:00:00.000Z");
    const { token, expiresAt } = signRawToken(secret, { projectId: "p1", machineId: "m1" }, now);
    expect(verifyRawToken(secret, token, Date.parse(expiresAt) + 1)).toBe("expired");
  });

  it("密钥是从会话密钥派生的：直接用会话密钥签出的令牌校验不通过", () => {
    const secret = rawTokenSecret(SESSION_SECRET);
    const now = new Date("2026-09-28T00:00:00.000Z");
    const { token } = signRawToken(Buffer.from(SESSION_SECRET), { projectId: "p1", machineId: "m1" }, now);
    expect(verifyRawToken(secret, token, now.getTime())).toBeNull();
  });
});
