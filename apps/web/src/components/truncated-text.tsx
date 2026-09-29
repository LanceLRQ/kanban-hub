"use client";

import { useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

type Overflowable = Pick<HTMLElement, "scrollWidth" | "clientWidth" | "scrollHeight" | "clientHeight">;

/** 内容是否被截断（宽或高超出可见区域）；1 像素以内的差值当作舍入误差 */
export function isTruncated(el: Overflowable | null): boolean {
  if (!el) return false;
  return el.scrollWidth - el.clientWidth > 1 || el.scrollHeight - el.clientHeight > 1;
}

/**
 * 超长省略的文字：单行（默认）或多行截断，末尾是省略号；只有真的被截断时，鼠标悬停或键盘聚焦
 * 才弹出完整内容，没截断就不弹。弹层的定位、翻转和无障碍属性交给 components/ui/tooltip。
 */
export function TruncatedText({ text, lines = 1, className }: { text: string; lines?: 1 | 2; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip open={open} onOpenChange={(next) => setOpen(next && isTruncated(ref.current))}>
        <TooltipTrigger asChild>
          <span ref={ref} className={cn(lines === 1 ? "block truncate" : "line-clamp-2", "min-w-0", className)}>
            {text}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="kh-tooltip max-w-xs break-all text-left text-pretty">
          {text}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
