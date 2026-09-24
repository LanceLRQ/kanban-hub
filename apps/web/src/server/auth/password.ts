import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

/** scrypt 的成本参数；keylen（64 字节）和盐长度（16 字节）固定，不随参数变化 */
export interface ScryptCostParams {
  N: number;
  r: number;
  p: number;
}

const DEFAULT_PARAMS: ScryptCostParams = { N: 16384, r: 8, p: 1 };
const KEYLEN = 64;
const SALT_LENGTH = 16;

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// Node 的 scrypt 要求 maxmem >= 128 * N * r（近似），默认 32MB 只够默认参数；
// 自定义更高成本的参数时按需放大，避免调用方传入非默认参数就报 ERR_CRYPTO_INVALID_SCRYPT_PARAMS
function maxmemFor(params: ScryptCostParams): number {
  return Math.max(32 * 1024 * 1024, 128 * params.N * params.r * 2);
}

/** 生成 `scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>`；盐每次随机，不传参数时用默认成本 */
export async function hashPassword(password: string, params: ScryptCostParams = DEFAULT_PARAMS): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password, salt, KEYLEN, { ...params, maxmem: maxmemFor(params) });
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

/** 校验密码；成本参数从 stored 里读取，格式不对或校验计算出错都返回 false，不抛错 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6) return false;
  const [scheme, nStr, rStr, pStr, saltHex, hashHex] = parts;
  if (scheme !== "scrypt" || nStr === undefined || rStr === undefined || pStr === undefined) return false;
  if (saltHex === undefined || hashHex === undefined) return false;
  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (N <= 0 || r <= 0 || p <= 0) return false;
  if (!/^[0-9a-f]+$/.test(saltHex) || !/^[0-9a-f]+$/.test(hashHex)) return false;
  // 十六进制字符合法只保证字符集，不保证解码后的字节长度：hashHex 过短（例如 "a"）会让
  // Buffer.from 解出比 KEYLEN 短甚至空的 Buffer，导致后面的 scrypt 以更短的 keylen 计算、
  // timingSafeEqual 两边都变短甚至都为空而恒等，等价于认证绕过。显式校验字节长度堵住这个口子。
  if (saltHex.length !== SALT_LENGTH * 2 || hashHex.length !== KEYLEN * 2) return false;

  try {
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    const params = { N, r, p };
    const derived = await scrypt(password, salt, expected.length, { ...params, maxmem: maxmemFor(params) });
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
