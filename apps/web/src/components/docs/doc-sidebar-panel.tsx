"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 文档页左栏的一个面板（文件树、最近更新）：标题栏固定，内容区在面板内部滚动。
 * 折叠只给窄屏用——窄屏下左栏排在正文上方、不吸顶，面板太长会把正文挤到很远；宽屏下左栏吸顶，
 * 标题不可点击、始终展开。
 */
export function DocSidebarPanel({
  title,
  className,
  bodyClassName,
  activeKey,
  children,
}: {
  title: string;
  className?: string;
  bodyClassName?: string;
  /** 当前项（`[data-active="true"]`）变化时，把它滚进内容区的可见范围；不传则不滚动 */
  activeKey?: string | null;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body || activeKey == null) return;
    const item = body.querySelector<HTMLElement>('[data-active="true"]');
    if (!item) return;
    // 只滚面板自己的内容区，不用 scrollIntoView（会连带滚动整个页面）
    const itemTop = item.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
    body.scrollTop = scrollTopToReveal({ itemTop, itemHeight: item.offsetHeight, viewHeight: body.clientHeight, scrollTop: body.scrollTop });
  }, [activeKey]);

  return (
    <section className={cn("kh-doc-panel flex flex-col rounded-md border border-border bg-card p-2", className)}>
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((c) => !c)}
        className="kh-doc-panel-head flex items-center justify-between text-left md:pointer-events-none md:cursor-default"
      >
        <span>{title}</span>
        <ChevronDownIcon className={cn("size-3.5 shrink-0 transition-transform md:hidden", collapsed && "-rotate-90")} aria-hidden="true" />
      </button>
      <div ref={bodyRef} className={cn("kh-doc-panel-body min-h-0 overflow-y-auto", bodyClassName, collapsed && "max-md:hidden")}>
        {children}
      </div>
    </section>
  );
}

/**
 * 让当前项出现在滚动区域里时，内容区应有的 scrollTop：已经完整可见就不动；否则滚到让它处在
 * 可见范围上方三分之一处（上下都留出上下文），不小于 0。
 */
export function scrollTopToReveal({
  itemTop,
  itemHeight,
  viewHeight,
  scrollTop,
}: {
  itemTop: number;
  itemHeight: number;
  viewHeight: number;
  scrollTop: number;
}): number {
  const visible = itemTop >= scrollTop && itemTop + itemHeight <= scrollTop + viewHeight;
  if (visible) return scrollTop;
  return Math.max(0, Math.round(itemTop - viewHeight / 3));
}
