import { randomBytes as nodeRandomBytes } from "node:crypto";

/** 配对码字母表：去掉容易混淆的 0、O、1、I、L */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
/** 拒绝采样的阈值：256 里能被 ALPHABET.length 整除的最大部分，避免取模偏差 */
const REJECTION_THRESHOLD = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
/** 配对码长度（不含分隔符），显示时切成 XXX-XXX */
const CODE_LENGTH = 6;
/** 默认有效期：10 分钟 */
const DEFAULT_TTL_MS = 10 * 60_000;

export interface PairingGrant {
  code: string;
  userId: string;
  expiresAt: string;
}

interface PairingEntry {
  userId: string;
  expiresAtMs: number;
}

type RandomBytes = (n: number) => Uint8Array;

function defaultRandomBytes(n: number): Uint8Array {
  return new Uint8Array(nodeRandomBytes(n));
}

/** 转大写、去掉连字符和空白，兑换时按这个规范化的形式查找 */
function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[-\s]+/g, "");
}

function formatCode(raw: string): string {
  return `${raw.slice(0, 3)}-${raw.slice(3)}`;
}

export class PairingRegistry {
  private readonly now: () => Date;
  private readonly random: RandomBytes;
  private readonly ttlMs: number;
  /** key 是规范化后（无连字符、大写）的码 */
  private readonly entries = new Map<string, PairingEntry>();

  constructor(opts: { now: () => Date; random?: RandomBytes; ttlMs?: number }) {
    this.now = opts.now;
    this.random = opts.random ?? defaultRandomBytes;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  }

  /** 签发一个新的配对码；生成结果与未过期的码重复时重新生成 */
  issue(userId: string): { code: string; expiresAt: string } {
    this.sweepExpired();
    let raw: string;
    do {
      raw = this.generateRaw();
    } while (this.entries.has(raw));

    const expiresAtMs = this.now().getTime() + this.ttlMs;
    this.entries.set(raw, { userId, expiresAtMs });
    return { code: formatCode(raw), expiresAt: new Date(expiresAtMs).toISOString() };
  }

  /** 兑换配对码：一次性使用，命中即从注册表移除；过期的码兑换失败 */
  consume(input: string): PairingGrant | null {
    this.sweepExpired();
    const raw = normalizeCode(input);
    const entry = this.entries.get(raw);
    if (!entry) return null;

    this.entries.delete(raw);
    if (entry.expiresAtMs <= this.now().getTime()) return null;
    return { code: formatCode(raw), userId: entry.userId, expiresAt: new Date(entry.expiresAtMs).toISOString() };
  }

  /** 兑换后续步骤失败时，把配对码原样放回去；已经过期的不放回 */
  restore(grant: PairingGrant): void {
    const expiresAtMs = Date.parse(grant.expiresAt);
    if (expiresAtMs <= this.now().getTime()) return;
    this.entries.set(normalizeCode(grant.code), { userId: grant.userId, expiresAtMs });
  }

  private generateRaw(): string {
    let code = "";
    while (code.length < CODE_LENGTH) {
      for (const b of this.random(CODE_LENGTH)) {
        if (b < REJECTION_THRESHOLD && code.length < CODE_LENGTH) {
          code += ALPHABET.charAt(b % ALPHABET.length);
        }
      }
    }
    return code;
  }

  /** 清理已过期但尚未被兑换的码；不开定时器，靠 issue/consume 顺带触发 */
  private sweepExpired(): void {
    const nowMs = this.now().getTime();
    for (const [raw, entry] of this.entries) {
      if (entry.expiresAtMs <= nowMs) this.entries.delete(raw);
    }
  }
}
