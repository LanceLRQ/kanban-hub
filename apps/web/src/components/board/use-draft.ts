"use client";

import { useState } from "react";

/**
 * 编辑中的草稿：服务端的值变了就丢弃草稿、改显示新值——页面刷新（包括 409 之后的刷新、
 * 实时推送触发的刷新）带来的新数据总是覆盖本地草稿。不用 effect 同步，而是记住草稿基于哪个值。
 *
 * “值变了”按 `key` 用 Object.is 判断，默认就是 value 本身；value 是对象时（每次刷新都是新引用），
 * 调用方传一个能代表内容的稳定字符串作为 key。
 */
export function useDraft<T>(value: T, key: unknown = value): [T, (next: T) => void, () => void] {
  const [state, setState] = useState({ key, draft: value });
  const draft = Object.is(state.key, key) ? state.draft : value;
  return [draft, (next: T) => setState({ key, draft: next }), () => setState({ key, draft: value })];
}
