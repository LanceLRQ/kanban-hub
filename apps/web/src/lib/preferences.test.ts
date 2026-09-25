import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREFERENCES,
  PREFERENCE_KEYS,
  PREFERENCE_SCRIPT,
  parsePreferences,
} from "./preferences";

describe("parsePreferences", () => {
  it("合法值原样返回", () => {
    expect(parsePreferences({ theme: "collage", mono: "fira-code", cjk: "noto-sans-sc" })).toEqual({
      theme: "collage",
      mono: "fira-code",
      cjk: "noto-sans-sc",
    });
  });

  it("缺失、空串、未知值都回退到默认值", () => {
    expect(parsePreferences({})).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences({ theme: null, mono: null, cjk: null })).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences({ theme: "", mono: "", cjk: "" })).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences({ theme: "not-a-theme", mono: "not-a-font", cjk: "not-a-font" })).toEqual(
      DEFAULT_PREFERENCES,
    );
  });

  it("三个字段互不影响：只有一个字段合法时，其余两个仍回退到默认值", () => {
    expect(parsePreferences({ theme: "collage" })).toEqual({
      ...DEFAULT_PREFERENCES,
      theme: "collage",
    });
    expect(parsePreferences({ mono: "ibm-plex-mono" })).toEqual({
      ...DEFAULT_PREFERENCES,
      mono: "ibm-plex-mono",
    });
    expect(parsePreferences({ cjk: "noto-serif-sc" })).toEqual({
      ...DEFAULT_PREFERENCES,
      cjk: "noto-serif-sc",
    });
  });
});

describe("PREFERENCE_SCRIPT", () => {
  function runScript(getItem: (key: string) => string | null | never) {
    const html: Record<string, string> = {};
    const fakeDocument = {
      documentElement: {
        setAttribute(name: string, value: string) {
          html[name] = value;
        },
      },
    };
    const fakeLocalStorage = { getItem };
    // 首帧脚本在浏览器里以内联 <script> 形式执行，这里用 new Function 复现同样的执行环境
    const run = new Function("document", "localStorage", PREFERENCE_SCRIPT);
    run(fakeDocument, fakeLocalStorage);
    return html;
  }

  it("从 localStorage 读取合法值并设置对应的 data-* 属性", () => {
    const html = runScript((key) => {
      if (key === PREFERENCE_KEYS.theme) return "collage";
      if (key === PREFERENCE_KEYS.mono) return "fira-code";
      if (key === PREFERENCE_KEYS.cjk) return "noto-serif-sc";
      return null;
    });
    expect(html["data-theme"]).toBe("collage");
    expect(html["data-font-mono"]).toBe("fira-code");
    expect(html["data-font-cjk"]).toBe("noto-serif-sc");
  });

  it("localStorage 抛异常时用默认值（隐私模式等）", () => {
    const html = runScript(() => {
      throw new Error("localStorage 不可用");
    });
    expect(html["data-theme"]).toBe(DEFAULT_PREFERENCES.theme);
    expect(html["data-font-mono"]).toBe(DEFAULT_PREFERENCES.mono);
    expect(html["data-font-cjk"]).toBe(DEFAULT_PREFERENCES.cjk);
  });

  it("localStorage 返回 null（未设置过）时用默认值", () => {
    const html = runScript(() => null);
    expect(html["data-theme"]).toBe(DEFAULT_PREFERENCES.theme);
    expect(html["data-font-mono"]).toBe(DEFAULT_PREFERENCES.mono);
    expect(html["data-font-cjk"]).toBe(DEFAULT_PREFERENCES.cjk);
  });

  it("localStorage 里存的是不合法值时回退到默认值", () => {
    const html = runScript((key) => (key === PREFERENCE_KEYS.theme ? "not-a-theme" : null));
    expect(html["data-theme"]).toBe(DEFAULT_PREFERENCES.theme);
  });
});
