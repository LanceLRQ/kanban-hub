import type { ReactNode } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import "./settings.css";

/**
 * 接入页、设置页、项目设置标签共用的卡片外壳：标题行（可选编号方框 + 标题 + 等宽小标签）
 * 走浅纸色底，下面是一组两栏行（见 `SectionRow`），行与行之间用细分隔线隔开。
 * `.kh-settings-card`/`.kh-settings-card-head`/`.kh-settings-no`/`.kh-settings-row` 是
 * 主题相关的样式钩子（见 `settings.css`）：主题 B 换成不对称圆角、纸色表头、虚线分隔、
 * 去掉编号方框的边框，组件本身不分叉。
 */
export function SectionCard({
  title,
  subtitle,
  no,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  /** 步骤编号（“1”“2”“3”），只有接入页的三步用到 */
  no?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("kh-settings-card overflow-hidden rounded-md border bg-card shadow-[var(--shadow-raised)]", className)}>
      <header className="kh-settings-card-head flex items-center gap-2.5 border-b bg-background px-5 py-3 [border-bottom-color:var(--border-soft)]">
        {no && (
          <span className="kh-settings-no kh-num rounded-sm border-2 px-2 py-0.5 text-xs font-extrabold tracking-[0.12em]">{no}</span>
        )}
        <h2 className="text-sm font-bold">{title}</h2>
        {subtitle && <span className="font-mono text-[11px] font-bold tracking-[0.14em] text-muted-foreground lowercase">{subtitle}</span>}
      </header>
      <div className="divide-y">{children}</div>
    </section>
  );
}

/** 卡片里的一行：左边窄栏放标签，右边放内容。用于命令行、只读信息、操作按钮等场景 */
export function SectionRow({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("kh-settings-row flex flex-col gap-2 px-5 py-3.5 sm:flex-row sm:items-center sm:gap-4", className)}>
      <div className="w-full shrink-0 text-xs font-bold text-muted-foreground sm:w-36">{label}</div>
      <div className="min-w-0 flex-1 text-sm">{children}</div>
    </div>
  );
}

/**
 * 页面标题卡：`/settings`、`/setup` 顶部的标题（中文标题 + 英文小标签），接入页的
 * “返回设置”按钮放在同一张卡片里。项目设置标签沿用既有的 `ProjectHeader`/`ProjectTabs`，
 * 不用这个组件。
 */
export function PageTitleCard({
  title,
  subtitle,
  backHref,
  backLabel,
}: {
  title: string;
  subtitle?: string;
  backHref?: string;
  backLabel?: string;
}) {
  return (
    <section className="kh-settings-card kh-settings-title-card flex flex-wrap items-center gap-3 rounded-md border bg-card px-6 py-4 shadow-[var(--shadow-raised)]">
      {backHref && backLabel && (
        <Link href={backHref} className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
          &larr; {backLabel}
        </Link>
      )}
      <h1 className="text-xl font-bold">{title}</h1>
      {subtitle && <span className="font-mono text-xs font-bold tracking-[0.14em] text-muted-foreground lowercase">{subtitle}</span>}
    </section>
  );
}
