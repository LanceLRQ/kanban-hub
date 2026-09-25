import { cn } from "@/lib/utils";

/**
 * 总览页两个区块共用的标题行：编号方框、标题、计数徽标、英文小标签、右侧延伸的分隔线，
 * 数字与编号用 `.kh-num` 走等宽字体。
 */
export function SectionHead({
  no,
  title,
  count,
  tag,
  tone = "default",
}: {
  no: string;
  title: string;
  count: number;
  tag: string;
  tone?: "attention" | "default";
}) {
  return (
    <div className="mt-11 mb-5 flex items-center gap-3.5 first:mt-0">
      <span className="kh-num kh-radius-a rounded-sm border-2 px-2 py-0.5 text-xs font-extrabold tracking-[0.12em]">{no}</span>
      <h2 className="text-[26px] leading-none font-black tracking-tight">{title}</h2>
      <span
        className={cn(
          "kh-num kh-radius-a rounded-sm border-2 px-2.5 py-0.5 text-sm font-extrabold",
          tone === "attention" ? "bg-human-decision/25" : "bg-card",
        )}
      >
        {count}
      </span>
      <span className="text-[11px] font-bold tracking-[0.14em] text-muted-foreground uppercase">{tag}</span>
      <span className="h-0 flex-1 translate-y-1 border-b-2 border-border/60" aria-hidden="true" />
    </div>
  );
}
