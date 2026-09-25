"use client";

import { useState } from "react";
import Link from "next/link";
import type { HumanKind } from "@kanban-hub/core/schema";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import "./overview.css";

export interface InboxGroupItemView {
  projectId: string;
  taskId: string;
  ref: string;
  text: string;
  projectName: string;
  relativeTime: string;
}

/** 待你处理的语义色，来自 tokens.css 的 --human-*；主题 A 直接填充，主题 B 改成描边加圆点（overview.css） */
const HUMAN_BG_CLASS: Record<HumanKind, string> = {
  decision: "bg-human-decision",
  verify: "bg-human-verify",
  action: "bg-human-action",
};

/** 三组固定各用一种不对称圆角，只在主题 B 生效（overview.css），主题 A 下 --radius-a/-b/-c 都等于 --radius */
const RADIUS_CLASS: Record<HumanKind, string> = {
  decision: "kh-radius-a",
  verify: "kh-radius-b",
  action: "kh-radius-c",
};

/**
 * 收件箱的一个分组：可展开收起，默认都展开，
 * `title` 已经是调用方拼好的“待决策 ×2”这种形式。点击条目跳到 `/p/<项目>?task=<任务>`。
 */
export function InboxGroupCard({
  kind,
  title,
  items,
  collapseLabel,
  expandLabel,
}: {
  kind: HumanKind;
  title: string;
  items: InboxGroupItemView[];
  collapseLabel: string;
  expandLabel: string;
}) {
  const [open, setOpen] = useState(true);

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      data-tone={kind}
      className={cn(
        "kh-overview-group relative flex flex-col overflow-hidden rounded-md border bg-card shadow-[var(--shadow-raised)]",
        RADIUS_CLASS[kind],
      )}
    >
      <span className="kh-overview-tape" aria-hidden="true" />
      <CollapsibleTrigger
        className="flex w-full items-center gap-2.5 border-b bg-muted/40 px-3.5 py-2.5 text-left"
        aria-label={open ? collapseLabel : expandLabel}
      >
        <span className={cn("kh-overview-kind-badge kh-num inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-0.5 text-sm font-extrabold", HUMAN_BG_CLASS[kind])}>
          <span className={cn("kh-overview-kind-dot", HUMAN_BG_CLASS[kind])} aria-hidden="true" />
          {title}
        </span>
        <span className="kh-overview-fold ml-auto font-mono text-base leading-none font-bold" aria-hidden="true">
          {open ? "−" : "+"}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-1 flex-col">
        {items.map((item, i) => (
          <Link
            key={item.taskId}
            href={`/p/${item.projectId}?task=${item.taskId}`}
            className={cn(
              "kh-overview-divider flex flex-col gap-1.5 px-3.5 py-3 hover:bg-muted/30",
              i < items.length - 1 && "border-b border-border/60",
            )}
          >
            <div className="flex items-baseline justify-between gap-2.5">
              <span className="kh-num text-xs font-extrabold">{item.ref}</span>
              <span className="kh-num text-[11px] font-medium text-muted-foreground">{item.relativeTime}</span>
            </div>
            <p className="text-sm leading-snug font-bold">{item.text}</p>
            <span className="inline-flex w-fit items-center rounded-sm border bg-card px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
              {item.projectName}
            </span>
          </Link>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}
