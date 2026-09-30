import { cn } from "@/lib/utils";

/** 项目卡片的进度条：total 个分段，已完成的实心，其余空心 */
export function ProgressBar({ done, total }: { done: number; total: number }) {
  if (total === 0) {
    return <span className="h-2 flex-1 rounded-full border border-dashed border-border" aria-hidden="true" />;
  }
  return (
    // min-w-0 + overflow-hidden：分段各有 2px 边框、段间 2px 间隙，几十段的
    // min-content 有两百多像素——极窄卡片里进度条压不到这个宽度时，允许它收缩
    // 并裁掉右端溢出的分段，把旁边 shrink-0 的「n/m」计数保住，不让计数
    // 穿出卡片边框。
    <div className="flex min-w-0 flex-1 gap-0.5 overflow-hidden" aria-hidden="true">
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={cn("h-2 flex-1 rounded-[1px] border border-border", i < done ? "bg-foreground" : "bg-transparent")} />
      ))}
    </div>
  );
}
