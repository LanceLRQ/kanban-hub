"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import "./filter-chip.css";

/** 工具栏里的开关式标签：选中用 secondary，未选中用 outline；看板和项目列表共用 */
export function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Button
      type="button"
      variant={active ? "secondary" : "outline"}
      size="sm"
      aria-pressed={active}
      onClick={onClick}
      className="kh-filter-chip"
    >
      {children}
    </Button>
  );
}
