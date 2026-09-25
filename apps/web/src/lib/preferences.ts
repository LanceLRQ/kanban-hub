"use client";

import { useCallback, useSyncExternalStore } from "react";

/** 两套可切换的界面主题：A 褪色印刷（默认）、B 纸本拼贴 */
export const THEMES = ["print", "collage"] as const;
export type Theme = (typeof THEMES)[number];

/** 可选的等宽字体，默认第一个 */
export const MONO_FONTS = ["jetbrains-mono", "ibm-plex-mono", "fira-code"] as const;
export type MonoFont = (typeof MONO_FONTS)[number];

/** 可选的中文字体，默认第一个 */
export const CJK_FONTS = ["lxgw-wenkai", "noto-sans-sc", "noto-serif-sc"] as const;
export type CjkFont = (typeof CJK_FONTS)[number];

export interface Preferences {
  theme: Theme;
  mono: MonoFont;
  cjk: CjkFont;
}

export const DEFAULT_PREFERENCES: Preferences = {
  theme: THEMES[0],
  mono: MONO_FONTS[0],
  cjk: CJK_FONTS[0],
};

/** localStorage 键名 */
export const PREFERENCE_KEYS = {
  theme: "kh-theme",
  mono: "kh-font-mono",
  cjk: "kh-font-cjk",
} as const;

/** raw 值不合法（缺失、空串、未知值）时回退到默认值 */
export function parsePreferences(raw: {
  theme?: string | null;
  mono?: string | null;
  cjk?: string | null;
}): Preferences {
  return {
    theme: isTheme(raw.theme) ? raw.theme : DEFAULT_PREFERENCES.theme,
    mono: isMonoFont(raw.mono) ? raw.mono : DEFAULT_PREFERENCES.mono,
    cjk: isCjkFont(raw.cjk) ? raw.cjk : DEFAULT_PREFERENCES.cjk,
  };
}

function isTheme(v: string | null | undefined): v is Theme {
  return typeof v === "string" && v.length > 0 && (THEMES as readonly string[]).includes(v);
}

function isMonoFont(v: string | null | undefined): v is MonoFont {
  return typeof v === "string" && v.length > 0 && (MONO_FONTS as readonly string[]).includes(v);
}

function isCjkFont(v: string | null | undefined): v is CjkFont {
  return typeof v === "string" && v.length > 0 && (CJK_FONTS as readonly string[]).includes(v);
}

/**
 * 首帧内联脚本：在页面绘制前从 localStorage 读取偏好并设置 <html> 的 data-* 属性，避免闪烁。
 * localStorage 不可用（隐私模式等）或读取抛异常时静默回退到默认值。
 * 内容是纯静态字符串（不拼接任何运行时数据），供 layout.tsx 用 dangerouslySetInnerHTML 内联到 <head>。
 */
export const PREFERENCE_SCRIPT = `
(function () {
  var THEMES = ${JSON.stringify(THEMES)};
  var MONO_FONTS = ${JSON.stringify(MONO_FONTS)};
  var CJK_FONTS = ${JSON.stringify(CJK_FONTS)};
  var KEYS = ${JSON.stringify(PREFERENCE_KEYS)};
  var DEFAULTS = ${JSON.stringify(DEFAULT_PREFERENCES)};

  function read(key, allowed, fallback) {
    try {
      var v = localStorage.getItem(key);
      if (typeof v === "string" && v.length > 0 && allowed.indexOf(v) !== -1) return v;
    } catch (e) {
      // localStorage 不可用（隐私模式等），静默回退
    }
    return fallback;
  }

  var theme = read(KEYS.theme, THEMES, DEFAULTS.theme);
  var mono = read(KEYS.mono, MONO_FONTS, DEFAULTS.mono);
  var cjk = read(KEYS.cjk, CJK_FONTS, DEFAULTS.cjk);

  document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.setAttribute("data-font-mono", mono);
  document.documentElement.setAttribute("data-font-cjk", cjk);
})();
`;

/** 读取 localStorage 里的偏好；不可用（隐私模式等）或没设置过时回退到默认值 */
export function readPreferences(): Preferences {
  if (typeof window === "undefined") return DEFAULT_PREFERENCES;
  try {
    return parsePreferences({
      theme: window.localStorage.getItem(PREFERENCE_KEYS.theme),
      mono: window.localStorage.getItem(PREFERENCE_KEYS.mono),
      cjk: window.localStorage.getItem(PREFERENCE_KEYS.cjk),
    });
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

/** `<html>` 上三个偏好属性的名字到目标值的映射 */
export type PreferenceAttributes = Record<"data-theme" | "data-font-mono" | "data-font-cjk", string>;

export function preferenceAttributes(preferences: Preferences): PreferenceAttributes {
  return {
    "data-theme": preferences.theme,
    "data-font-mono": preferences.mono,
    "data-font-cjk": preferences.cjk,
  };
}

/**
 * 纯函数：比较 `<html>` 上已有的属性值和目标偏好，只返回值不同的那几项。
 * 供 `applyPreferences` 判断要不要写 DOM，也单独导出方便测试——不依赖 `document`。
 */
export function diffPreferenceAttributes(
  current: Partial<PreferenceAttributes>,
  target: PreferenceAttributes,
): Partial<PreferenceAttributes> {
  const diff: Partial<PreferenceAttributes> = {};
  for (const key of Object.keys(target) as (keyof PreferenceAttributes)[]) {
    if (current[key] !== target[key]) diff[key] = target[key];
  }
  return diff;
}

/** 把偏好写到 `<html>` 的 data-* 属性上；已经是目标值的属性不重复写入 */
export function applyPreferences(preferences: Preferences): void {
  const html = document.documentElement;
  const current: Partial<PreferenceAttributes> = {
    "data-theme": html.getAttribute("data-theme") ?? undefined,
    "data-font-mono": html.getAttribute("data-font-mono") ?? undefined,
    "data-font-cjk": html.getAttribute("data-font-cjk") ?? undefined,
  };
  const diff = diffPreferenceAttributes(current, preferenceAttributes(preferences));
  for (const [attr, value] of Object.entries(diff)) html.setAttribute(attr, value);
}

/*
 * usePreferences 用 useSyncExternalStore 而不是 useState+useEffect 读取 localStorage：
 * 服务端渲染和客户端首次渲染都用 getServerSnapshot（默认值），避免两端不一致的水合警告；
 * 挂载后 React 会用 getSnapshot 重新读取一次真实偏好，写入时用 notify() 通知订阅者刷新。
 */
let cachedPreferences: Preferences | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): Preferences {
  cachedPreferences ??= readPreferences();
  return cachedPreferences;
}

function getServerSnapshot(): Preferences {
  return DEFAULT_PREFERENCES;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify() {
  for (const listener of listeners) listener();
}

/** 客户端 hook：读写偏好，同时写 localStorage 和 <html> 的 data-* 属性 */
export function usePreferences() {
  const preferences = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const persist = useCallback((next: Preferences) => {
    cachedPreferences = next;
    applyPreferences(next);
    try {
      window.localStorage.setItem(PREFERENCE_KEYS.theme, next.theme);
      window.localStorage.setItem(PREFERENCE_KEYS.mono, next.mono);
      window.localStorage.setItem(PREFERENCE_KEYS.cjk, next.cjk);
    } catch {
      // localStorage 不可用时，偏好仍在本次会话内生效，只是不持久化
    }
    notify();
  }, []);

  const setTheme = useCallback(
    (theme: Theme) => persist({ ...preferences, theme }),
    [preferences, persist],
  );
  const setMonoFont = useCallback(
    (mono: MonoFont) => persist({ ...preferences, mono }),
    [preferences, persist],
  );
  const setCjkFont = useCallback(
    (cjk: CjkFont) => persist({ ...preferences, cjk }),
    [preferences, persist],
  );

  return { preferences, setTheme, setMonoFont, setCjkFont };
}
