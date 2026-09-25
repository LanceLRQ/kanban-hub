"use client";

import type { CSSProperties } from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

/**
 * shadcn/ui 的 sonner 组件通常经 next-themes 联动亮/暗色；本项目只有两套亮色主题
 * （通过 [data-theme] 切换，不是明暗色），所以这里直接固定 theme="light"，
 * 具体视觉交给 globals.css 里的 token 覆盖，不引入 next-themes 依赖。
 */
function Toaster(props: ToasterProps) {
  return (
    <Sonner
      theme="light"
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as CSSProperties
      }
      {...props}
    />
  );
}

export { Toaster };
