import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * 接入页、设置页、项目设置标签共用的卡片外壳：标题 + 等宽小标签，下面是一组两栏行
 * （见 `SectionRow`）。视觉上是“盒状卡片、标题行 + 分隔线隔开的若干行”，
 * 不写死颜色/圆角/阴影，全部走 token 或已有的工具类。
 */
export function SectionCard({
  title,
  subtitle,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("kh-radius-a overflow-hidden rounded-md border bg-card shadow-[var(--shadow-raised)]", className)}>
      <header className="flex items-baseline gap-2.5 border-b bg-secondary/40 px-5 py-3">
        <h2 className="text-sm font-bold">{title}</h2>
        {subtitle && <span className="kh-num text-xs font-medium text-muted-foreground">{subtitle}</span>}
      </header>
      <div className="divide-y">{children}</div>
    </section>
  );
}

/** 卡片里的一行：左边窄栏放标签，右边放内容。用于命令行、只读信息、操作按钮等场景 */
export function SectionRow({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2 px-5 py-3.5 sm:flex-row sm:items-center sm:gap-4", className)}>
      <div className="w-full shrink-0 text-xs font-bold text-muted-foreground sm:w-36">{label}</div>
      <div className="min-w-0 flex-1 text-sm">{children}</div>
    </div>
  );
}
