"use client";

import { useEffect } from "react";
import { applyPreferences, readPreferences } from "@/lib/preferences";

/**
 * 兜底纠正外观：正常情况下首帧脚本（`beforeInteractive`）已经在绘制前把偏好设到 `<html>`
 * 上。但 `notFound()` 触发的路径是个例外——React 在客户端重新渲染根布局时不会重新执行
 * `beforeInteractive` 脚本，`<html>` 上的 data-* 属性会回退到默认值，页面短暂显示成默认外观。
 * 这个组件挂载时读一次 localStorage，把三个属性补设回去；`applyPreferences` 内部会跳过
 * 已经是目标值的属性，值本来就正确时不产生任何 DOM 写入。不渲染任何内容。
 */
export function PreferencesSync(): null {
  useEffect(() => {
    applyPreferences(readPreferences());
  }, []);

  return null;
}
