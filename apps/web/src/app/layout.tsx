import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";

import { PREFERENCE_SCRIPT } from "@/lib/preferences";
import { Toaster } from "@/components/ui/sonner";
import "@/styles/globals.css";

export const metadata = { title: "kanban-hub" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        {/*
          首帧内联脚本：在页面绘制前设置好 data-theme / data-font-mono / data-font-cjk，
          避免刷新时先出现默认外观再跳到用户偏好的闪烁。脚本内容是 preferences.ts 里的
          静态字符串，不拼接任何运行时数据。
        */}
        <script dangerouslySetInnerHTML={{ __html: PREFERENCE_SCRIPT }} />
      </head>
      <body>
        <NextIntlClientProvider>
          {children}
          <Toaster />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
