import { describe, expect, it } from "vitest";
import { PairingRegistry, type PairingGrant } from "./pairing";

/** 固定起点、可手动前进的时钟，用于精确控制过期边界 */
function mutableClock(iso: string): { now: () => Date; advance: (ms: number) => void } {
  let current = Date.parse(iso);
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

const CODE_CHAR = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_PATTERN = new RegExp(`^[${CODE_CHAR}]{3}-[${CODE_CHAR}]{3}$`);

describe("PairingRegistry", () => {
  it("生成 XXX-XXX 格式的配对码，只使用规定字母表", () => {
    const registry = new PairingRegistry({ now: mutableClock("2026-09-24T00:00:00.000Z").now });
    for (let i = 0; i < 50; i++) {
      const { code } = registry.issue("u1");
      expect(code).toMatch(CODE_PATTERN);
    }
  });

  it("issue 返回 ISO 格式的过期时间", () => {
    const c = mutableClock("2026-09-24T00:00:00.000Z");
    const registry = new PairingRegistry({ now: c.now, ttlMs: 10 * 60_000 });
    const { expiresAt } = registry.issue("u1");
    expect(expiresAt).toBe("2026-09-24T00:10:00.000Z");
  });

  it("兑换时忽略大小写和连字符", () => {
    const c = mutableClock("2026-09-24T00:00:00.000Z");
    const registry = new PairingRegistry({ now: c.now });
    const { code } = registry.issue("u1");
    const messy = ` ${code.toLowerCase().replace("-", "")} `.trim();
    const grant = registry.consume(messy);
    expect(grant).not.toBeNull();
    expect(grant?.userId).toBe("u1");
  });

  it("同一个码第二次兑换失败", () => {
    const c = mutableClock("2026-09-24T00:00:00.000Z");
    const registry = new PairingRegistry({ now: c.now });
    const { code } = registry.issue("u1");
    expect(registry.consume(code)).not.toBeNull();
    expect(registry.consume(code)).toBeNull();
  });

  it("到期前一刻能兑换，到期后不能兑换", () => {
    const c = mutableClock("2026-09-24T00:00:00.000Z");
    const registry = new PairingRegistry({ now: c.now, ttlMs: 10 * 60_000 });

    const { code: codeA } = registry.issue("u1");
    c.advance(10 * 60_000 - 1);
    expect(registry.consume(codeA)).not.toBeNull();

    const { code: codeB } = registry.issue("u2");
    c.advance(10 * 60_000);
    expect(registry.consume(codeB)).toBeNull();
  });

  it("restore 之后能再兑换一次", () => {
    const c = mutableClock("2026-09-24T00:00:00.000Z");
    const registry = new PairingRegistry({ now: c.now });
    const { code } = registry.issue("u1");
    const grant = registry.consume(code) as PairingGrant;
    expect(grant).not.toBeNull();

    registry.restore(grant);
    const again = registry.consume(code);
    expect(again).not.toBeNull();
    expect(again?.userId).toBe("u1");
  });

  it("restore 已过期的配对码不放回", () => {
    const c = mutableClock("2026-09-24T00:00:00.000Z");
    const registry = new PairingRegistry({ now: c.now, ttlMs: 60_000 });
    const { code } = registry.issue("u1");
    const grant = registry.consume(code) as PairingGrant;

    c.advance(60_000 + 1);
    registry.restore(grant);

    expect(registry.consume(code)).toBeNull();
  });

  it("生成的码与未过期的码重复时重新生成", () => {
    const c = mutableClock("2026-09-24T00:00:00.000Z");
    // 前两次拿到相同的字节（同一个码），第三次才不同：模拟一次冲突重试
    const scripted = [
      [2, 2, 2, 2, 2, 2],
      [2, 2, 2, 2, 2, 2],
      [3, 3, 3, 3, 3, 3],
    ];
    let call = 0;
    const random = (n: number) => {
      const bytes = scripted[Math.min(call, scripted.length - 1)]!;
      call++;
      return new Uint8Array(bytes.slice(0, n));
    };

    const registry = new PairingRegistry({ now: c.now, random });
    const first = registry.issue("u1");
    const second = registry.issue("u2");

    expect(second.code).not.toBe(first.code);
    expect(call).toBe(3);
  });
});
