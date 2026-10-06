import { cn } from "@/lib/utils";

/** 任务数不超过它时分段显示，超过时改为连续条：任务一多，分段细到看不出进度 */
const MAX_SEGMENTS = 10;

interface ProgressBarProps {
  done: number;
  /** 已开始但未完成（进行中、复核中、挂起）的任务数 */
  started: number;
  total: number;
  /** 悬停时显示的各状态明细 */
  title: string;
}

/**
 * 进度条（项目卡片、看板里程碑表头共用）：已完成绿色、已开始未完成黄色、待开始只有纸色底，
 * 颜色取看板上任务状态的同名 token。底色垫纸色：里程碑表头是芥末底，黄色段直接放上去看不清。
 * 不超过 MAX_SEGMENTS 个任务时每个任务一格；超过时是一根连续条，三层叠放——底层空轨道，
 * 中层黄色宽度为（已完成 + 已开始）/ 总数，顶层绿色宽度为已完成 / 总数。
 */
export function ProgressBar({ done, started, total, title }: ProgressBarProps) {
  if (total === 0) {
    return <span className="h-2 flex-1 rounded-full border border-dashed border-border" aria-hidden="true" />;
  }
  if (total > MAX_SEGMENTS) {
    return (
      <div title={title} className="relative h-2 min-w-0 flex-1 overflow-hidden rounded-full border border-border bg-card" aria-hidden="true">
        <span data-layer="started" className="absolute inset-y-0 left-0 bg-[var(--task-in-progress)]" style={{ width: percent(done + started, total) }} />
        <span data-layer="done" className="absolute inset-y-0 left-0 bg-[var(--task-done)]" style={{ width: percent(done, total) }} />
      </div>
    );
  }
  return (
    // min-w-0 + overflow-hidden：极窄卡片里允许分段条收缩并裁掉右端，保住旁边 shrink-0 的「n/m」计数
    <div title={title} className="flex min-w-0 flex-1 gap-0.5 overflow-hidden" aria-hidden="true">
      {Array.from({ length: total }, (_, i) => {
        const kind = i < done ? "done" : i < done + started ? "started" : "todo";
        return (
          <span
            key={i}
            data-segment={kind}
            className={cn(
              "h-2 flex-1 rounded-[1px] border border-border",
              kind === "done" ? "bg-[var(--task-done)]" : kind === "started" ? "bg-[var(--task-in-progress)]" : "bg-card",
            )}
          />
        );
      })}
    </div>
  );
}

function percent(part: number, total: number): string {
  return `${Math.round((part / total) * 1000) / 10}%`;
}
