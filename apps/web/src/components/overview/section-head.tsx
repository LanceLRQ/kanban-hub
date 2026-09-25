import { cn } from "@/lib/utils";
import "./overview.css";

/**
 * 总览页两个区块共用的标题行：编号方框、标题、计数徽标、英文小标签、右侧延伸的分隔线。
 * 数字与编号用 `.kh-num` 走等宽字体。区块之间的间距由父容器（页面）负责，这里只留标题
 * 和下方内容之间的间距，避免用 `first:` 之类的选择器误判——它按“在自己的 `<section>`
 * 里是不是第一个子元素”判断，两个区块的标题都是各自 section 里的第一个子元素，会被同时命中。
 *
 * `.kh-overview-sec-no`、`.kh-overview-sec-rule` 是主题 B 的样式钩子（见 overview.css）：
 * 主题 B 去掉编号的方框，分隔线改成双线；主题 A 保留原样，组件本身不分叉。
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
    <div className="mb-5 flex items-center gap-3.5">
      <span className="kh-overview-sec-no kh-num kh-radius-a rounded-sm border-2 px-2 py-0.5 text-xs font-extrabold tracking-[0.12em]">
        {no}
      </span>
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
      <span className="kh-overview-sec-rule h-0 flex-1 translate-y-1 border-b-2 border-border/60" aria-hidden="true" />
    </div>
  );
}
