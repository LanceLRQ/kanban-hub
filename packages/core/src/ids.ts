import { z } from "zod";

/** 实体 ID 的长度（规格 5.1） */
export const ID_LENGTH = 10;
/** 任务短 ID 的最短长度（规格 5.1） */
export const SHORT_ID_MIN = 4;

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export const idSchema = z.string().regex(/^[0-9a-z]{10}$/, "ID 必须是 10 位小写字母或数字");

function defaultRandomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** 生成实体 ID。randomBytes 可以注入，便于测试。 */
export function generateId(randomBytes: (n: number) => Uint8Array = defaultRandomBytes): string {
  let id = "";
  while (id.length < ID_LENGTH) {
    for (const b of randomBytes(ID_LENGTH)) {
      // 252 = 36 × 7，丢弃 252–255，每个字符的概率才相等
      if (b < 252 && id.length < ID_LENGTH) id += ALPHABET.charAt(b % 36);
    }
  }
  return id;
}

/** 为一组 ID 计算能互相区分的最短前缀（至少 min 位），返回 ID → 前缀 */
export function shortIdPrefixes(ids: readonly string[], min: number = SHORT_ID_MIN): Map<string, string> {
  const result = new Map<string, string>();
  for (const id of ids) {
    let len = Math.min(min, id.length);
    while (len < id.length && ids.some((other) => other !== id && other.startsWith(id.slice(0, len)))) len++;
    result.set(id, id.slice(0, len));
  }
  return result;
}
