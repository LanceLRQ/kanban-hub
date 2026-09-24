import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password";

// 测试用低成本参数，避免每个用例都跑一遍默认参数的 scrypt（几十毫秒 * 用例数）
const LOW_COST = { N: 16, r: 1, p: 1 };

describe("hashPassword", () => {
  it("写成 scrypt$N$r$p$saltHex$hashHex 的格式", async () => {
    const hash = await hashPassword("hunter2", LOW_COST);
    const parts = hash.split("$");
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe("scrypt");
    expect(parts[1]).toBe("16");
    expect(parts[2]).toBe("1");
    expect(parts[3]).toBe("1");
    expect(parts[4]).toMatch(/^[0-9a-f]{32}$/); // 16 字节盐
    expect(parts[5]).toMatch(/^[0-9a-f]{128}$/); // 64 字节哈希
  });

  it("不传参数时用默认值 N=16384、r=8、p=1", async () => {
    const hash = await hashPassword("hunter2");
    const [, N, r, p] = hash.split("$");
    expect([N, r, p]).toEqual(["16384", "8", "1"]);
  });

  it("同一密码两次哈希结果不同（盐不同）", async () => {
    const a = await hashPassword("hunter2", LOW_COST);
    const b = await hashPassword("hunter2", LOW_COST);
    expect(a).not.toBe(b);
  });
});

describe("verifyPassword", () => {
  it("正确密码校验通过，即使两次哈希盐不同", async () => {
    const a = await hashPassword("hunter2", LOW_COST);
    const b = await hashPassword("hunter2", LOW_COST);
    expect(await verifyPassword("hunter2", a)).toBe(true);
    expect(await verifyPassword("hunter2", b)).toBe(true);
  });

  it("错误密码校验失败", async () => {
    const hash = await hashPassword("hunter2", LOW_COST);
    expect(await verifyPassword("wrong-password", hash)).toBe(false);
  });

  it("参数从 stored 里读取：用低成本参数生成的哈希也能正确校验", async () => {
    const hash = await hashPassword("hunter2", { N: 32, r: 2, p: 1 });
    expect(await verifyPassword("hunter2", hash)).toBe(true);
  });

  it("格式损坏的哈希返回 false 而不抛错", async () => {
    await expect(verifyPassword("hunter2", "")).resolves.toBe(false);
    await expect(verifyPassword("hunter2", "not-a-hash")).resolves.toBe(false);
    await expect(verifyPassword("hunter2", "scrypt$16$1$1$onlyfour")).resolves.toBe(false);
    await expect(verifyPassword("hunter2", "scrypt$abc$1$1$aa$bb")).resolves.toBe(false);
    await expect(verifyPassword("hunter2", "scrypt$16$1$1$zz$zz")).resolves.toBe(false);
    await expect(verifyPassword("hunter2", "plain$16$1$1$aa$bb")).resolves.toBe(false);
  });

  it("hashHex/saltHex 字节长度不对（哪怕字符集合法）时返回 false，不因空 Buffer 而恒等", async () => {
    // hashHex 只有 1 个十六进制字符：Buffer.from("a", "hex") 解出空 Buffer，
    // 如果不显式校验字节长度，会以 keylen=0 调用 scrypt，两边都得到空 Buffer，
    // timingSafeEqual(空, 空) 恒为 true —— 等价于对任意密码都放行，是认证绕过
    await expect(verifyPassword("hunter2", "scrypt$16$1$1$aa$a")).resolves.toBe(false);
    await expect(verifyPassword("totally-wrong-password-xyz", "scrypt$16$1$1$aa$a")).resolves.toBe(false);
    // hashHex 奇数长度（非空但解码会截断最后一个半字节）
    await expect(verifyPassword("hunter2", `scrypt$16$1$1$aa$${"b".repeat(127)}`)).resolves.toBe(false);
    // hashHex 为空串
    await expect(verifyPassword("hunter2", "scrypt$16$1$1$aa$")).resolves.toBe(false);
    // saltHex 长度不足（应为 32 位十六进制，即 16 字节）
    await expect(verifyPassword("hunter2", `scrypt$16$1$1$aa$${"b".repeat(128)}`)).resolves.toBe(false);
  });
});
