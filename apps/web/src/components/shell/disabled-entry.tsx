"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * 还没做的入口的公共占位：置灰、不可点，hover 提示原因。
 * 项目页“文档”标签（M5）、设置页“加密备份”（M7）、项目设置“导出”（M6）都用它。
 */
export function DisabledEntry({ tooltip, className, children }: { tooltip: string; className?: string; children: ReactNode }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            aria-disabled="true"
            data-disabled="true"
            className={cn(
              "inline-flex cursor-not-allowed items-center gap-2 text-sm font-medium text-muted-foreground/70",
              className,
            )}
          >
            {children}
          </span>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
