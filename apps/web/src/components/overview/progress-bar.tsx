import { cn } from "@/lib/utils";

/** 项目卡片的进度条：total 个分段，已完成的实心，其余空心 */
export function ProgressBar({ done, total }: { done: number; total: number }) {
  if (total === 0) {
    return <span className="h-2 flex-1 rounded-full border border-dashed border-border" aria-hidden="true" />;
  }
  return (
    <div className="flex flex-1 gap-0.5" aria-hidden="true">
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={cn("h-2 flex-1 rounded-[1px] border border-border", i < done ? "bg-foreground" : "bg-transparent")} />
      ))}
    </div>
  );
}
