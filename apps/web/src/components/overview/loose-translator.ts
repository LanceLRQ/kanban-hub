/**
 * next-intl 的 `t()` 要求编译期字面量 key，但 describeEvent 产出的消息 key、枚举中文名的 key
 * 都是运行期拼出来的字符串。这里放宽类型（做法与 lib/events.test.ts 里手写的 LooseTranslator
 * 一致），调用方对 key 的合法性负责——真实的 key 总来自 lib/events.ts 或 enums.json 的固定枚举，
 * 不是用户输入。
 */
export type LooseTranslator = (key: string, values?: Record<string, string | number>) => string;

export function looseTranslator(t: unknown): LooseTranslator {
  return t as LooseTranslator;
}
