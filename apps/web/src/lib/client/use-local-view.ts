"use client";

import { useCallback, useRef, useSyncExternalStore } from "react";
import type { z } from "zod";

interface Entry {
  /** 上一次解析所用的原始字符串；null 表示键不存在，undefined 表示还没读过 */
  raw: string | null | undefined;
  parsed: unknown;
  /** localStorage 写入失败时只在内存里保存的值 */
  memory: { value: unknown } | null;
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

interface StoreWindow {
  localStorage: StorageLike;
  addEventListener(type: "storage", listener: (e: { key: string | null }) => void): void;
  removeEventListener(type: "storage", listener: (e: { key: string | null }) => void): void;
}

function currentWindow(): StoreWindow | undefined {
  return typeof window === "undefined" ? undefined : (window as unknown as StoreWindow);
}

const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();

function entryOf(key: string): Entry {
  let entry = entries.get(key);
  if (!entry) {
    entry = { raw: undefined, parsed: undefined, memory: null };
    entries.set(key, entry);
  }
  return entry;
}

function notify(key: string) {
  for (const listener of listeners.get(key) ?? []) listener();
}

function onStorage(event: { key: string | null }) {
  // key 为 null 表示整个存储被清空
  const keys = event.key === null ? [...listeners.keys()] : [event.key];
  for (const key of keys) {
    const entry = entries.get(key);
    if (entry) entry.memory = null;
    notify(key);
  }
}

function subscribeKey(key: string, listener: () => void): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  const first = listeners.size === 1 && set.size === 0;
  set.add(listener);
  if (first) currentWindow()?.addEventListener("storage", onStorage);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
    if (listeners.size === 0) currentWindow()?.removeEventListener("storage", onStorage);
  };
}

function readRaw(key: string): string | null | undefined {
  try {
    return currentWindow()?.localStorage.getItem(key);
  } catch {
    return undefined;
  }
}

function snapshotOf<T>(key: string, schema: z.ZodType<T>, defaults: T): T {
  const entry = entryOf(key);
  if (entry.memory) return entry.memory.value as T;
  const raw = readRaw(key);
  if (raw === undefined) return defaults;
  // 只有原始字符串变化时才重新解析，保证没变化时返回同一个对象
  if (entry.raw !== raw || (raw === null && entry.parsed !== defaults)) {
    entry.raw = raw;
    entry.parsed = raw === null ? defaults : parseOrDefault(raw, schema, defaults);
  }
  return entry.parsed as T;
}

function parseOrDefault<T>(raw: string, schema: z.ZodType<T>, defaults: T): T {
  try {
    const result = schema.safeParse(JSON.parse(raw));
    return result.success ? result.data : defaults;
  } catch {
    return defaults;
  }
}

function writeValue<T>(key: string, value: T) {
  const entry = entryOf(key);
  try {
    const win = currentWindow();
    if (!win) throw new Error("no window");
    win.localStorage.setItem(key, JSON.stringify(value));
    entry.memory = null;
  } catch {
    entry.memory = { value };
  }
  notify(key);
}

function removeValue(key: string) {
  const entry = entryOf(key);
  entry.memory = null;
  try {
    currentWindow()?.localStorage.removeItem(key);
  } catch {
    // localStorage 不可用时只清掉内存里的值
  }
  notify(key);
}

/**
 * 把视图选择（筛选、排序等）存进 localStorage。
 * 服务端渲染和首次水合一律返回 defaults，挂载后再读取已保存的值；
 * 原始值不是合法 JSON、不满足 schema、读取抛异常时回退到 defaults；
 * 写入抛异常时只在内存里保存；其他标签页的修改通过 storage 事件同步。
 * 同一个键必须始终使用同一份 schema 和 defaults：模块级缓存按键共享，后来者传入的不同定义不会生效。
 */
export function useLocalView<T>(
  key: string,
  schema: z.ZodType<T>,
  defaults: T,
): readonly [value: T, set: (next: T) => void, reset: () => void] {
  // 调用方可能每次渲染都传新的字面量，固定首次传入的引用，避免快照每次都变
  const schemaRef = useRef(schema);
  const defaultsRef = useRef(defaults);

  const subscribe = useCallback((listener: () => void) => subscribeKey(key, listener), [key]);
  const getSnapshot = useCallback(
    () => snapshotOf(key, schemaRef.current, defaultsRef.current),
    [key],
  );
  const getServerSnapshot = useCallback(() => defaultsRef.current, []);

  const value = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const set = useCallback((next: T) => writeValue(key, next), [key]);
  const reset = useCallback(() => removeValue(key), [key]);
  return [value, set, reset] as const;
}

/** 仅供测试：清空模块级缓存与订阅 */
export function resetLocalViewStoreForTest() {
  entries.clear();
  listeners.clear();
}
