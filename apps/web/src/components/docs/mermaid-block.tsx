"use client";

import { useEffect, useRef, useState } from "react";

/**
 * 页面里唯一的 innerHTML 例外：mermaid 生成的 SVG（mermaid 自带 DOMPurify 清理过）。
 * 只在这个组件被挂载时才动态 import("mermaid")——`components/docs/doc-markdown.tsx` 只在
 * 正文里确实遇到 `language-mermaid` 代码块时才渲染这个组件，保证没有 mermaid 代码块的页面
 * 不会加载 mermaid 这个较大的依赖。
 */

let mermaidModule: Promise<typeof import("mermaid")> | null = null;
function loadMermaid(): Promise<typeof import("mermaid")> {
  mermaidModule ??= import("mermaid");
  return mermaidModule;
}

function readThemeVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === "" ? fallback : value;
}

let initialized: Promise<Awaited<ReturnType<typeof loadMermaid>>["default"]> | null = null;

/** 初始化只做一次；主题按当前 `data-theme` 取一组中性配色（两套主题各自的 token 值），不用 mermaid 默认的彩色 */
async function ensureMermaid(): Promise<Awaited<ReturnType<typeof loadMermaid>>["default"]> {
  const mod = await loadMermaid();
  initialized ??= Promise.resolve().then(() => {
    mod.default.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      themeVariables: {
        primaryColor: readThemeVar("--card", "#f4f4f0"),
        primaryTextColor: readThemeVar("--foreground", "#1a1a1a"),
        primaryBorderColor: readThemeVar("--border", "#333333"),
        lineColor: readThemeVar("--foreground", "#1a1a1a"),
        secondaryColor: readThemeVar("--card", "#f4f4f0"),
        tertiaryColor: readThemeVar("--card", "#f4f4f0"),
        background: readThemeVar("--background", "#ffffff"),
        textColor: readThemeVar("--foreground", "#1a1a1a"),
      },
    });
    return mod.default;
  });
  return initialized;
}

let counter = 0;

/** 渲染一个 mermaid 代码块；渲染失败时显示原始代码 */
export function MermaidBlock({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const mermaid = await ensureMermaid();
        const { svg, bindFunctions } = await mermaid.render(`kh-mermaid-${counter++}`, code);
        if (cancelled || !ref.current) return;
        ref.current.innerHTML = svg;
        bindFunctions?.(ref.current);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (failed) {
    return <pre className="kh-mermaid-error">{code}</pre>;
  }
  return <div className="kh-mermaid" ref={ref} />;
}
