import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import Script from "next/script";

import { PREFERENCE_SCRIPT } from "@/lib/preferences";
import { PreferencesSync } from "@/components/preferences-sync";
import { Toaster } from "@/components/ui/sonner";
import "@/styles/globals.css";

export const metadata = { title: "kanban-hub" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // 首帧脚本（见下）在浏览器绘制前就把 data-theme / data-font-* 写到 <html> 上，
    // 而服务端渲染的这份 HTML 天然不知道用户存在 localStorage 里的偏好，两边的属性值
    // 免不了会短暂不一致；React 拿服务端标记去做 hydration diff 时会把这当成真的
    // 属性不匹配而报警，但这里是预期内的、只影响这三个属性的差异，加
    // suppressHydrationWarning 让 React 不为这个已知差异报警，其余属性/子树的
    // hydration 校验不受影响（这个属性只作用于它所在的这一个元素）。
    <html lang="zh-CN" suppressHydrationWarning>
      <body>
        {/*
          首帧脚本：在浏览器绘制前设置好 data-theme / data-font-mono / data-font-cjk，
          避免刷新时先出现默认外观再跳到用户偏好的闪烁。用 next/script 的 beforeInteractive
          策略而不是手写 <script dangerouslySetInnerHTML>：两者都能在 hydration 之前执行，
          但后者是 React 渲染出的裸 <script> DOM 节点，会触发 React 的
          “Encountered a script tag while rendering React component” 警告（React 认为脚本
          标签不该由它的渲染流程产出，即使这里的执行时机其实没问题）；beforeInteractive 是
          Next 官方给“必须在页面 hydrate 之前跑”的脚本提供的机制，由 Next 自己注入到 <head>
          里，不经过这条 React 警告路径，放在 layout 里哪个位置不影响这一点。内容仍然是
          preferences.ts 里的静态字符串，不拼接任何运行时数据。
        */}
        <Script id="kh-preferences" strategy="beforeInteractive" dangerouslySetInnerHTML={{ __html: PREFERENCE_SCRIPT }} />
        {/*
          兜底：notFound() 触发的路径由 React 在客户端重新渲染根布局，不会重新执行上面的
          beforeInteractive 脚本，<html> 上的偏好属性会回退到默认值。PreferencesSync 挂载时
          读一次 localStorage 补设回去，值已经正确时不做任何 DOM 写入，见组件内注释。
        */}
        <PreferencesSync />
        <NextIntlClientProvider>
          {children}
          <Toaster />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
