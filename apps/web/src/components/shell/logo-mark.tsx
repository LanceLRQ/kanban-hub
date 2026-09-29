import { cn } from "@/lib/utils";

/**
 * 顶栏字标左侧的图标：一块带套印阴影的看板，三列卡片分别用进行中、待验收、已完成的状态色。
 * 颜色全部取主题 token，随主题切换；浏览器标签页图标（app/icon.svg）是同一图形的固定配色版。
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={cn("kh-logo-mark", className)}>
      <rect x="4" y="5" width="26" height="25" rx="4" fill="var(--shadow-color)" />
      <rect x="2" y="3" width="26" height="25" rx="4" fill="var(--card)" stroke="var(--border)" strokeWidth="2" />
      <path d="M2 9.5h26" stroke="var(--border)" strokeWidth="1.5" />
      <path d="M6.5 6.25h3.5M13.25 6.25h3.5M20 6.25h3.5" stroke="var(--border)" strokeWidth="1.5" strokeLinecap="round" />
      <g stroke="var(--border)" strokeWidth="0.9">
        <rect x="5.5" y="12.5" width="5.5" height="7" rx="1" fill="var(--task-in-progress)" />
        <rect x="5.5" y="21.5" width="5.5" height="3.5" rx="1" fill="var(--task-in-progress)" fillOpacity="0.45" />
        <rect x="12.25" y="12.5" width="5.5" height="4.5" rx="1" fill="var(--task-review)" />
        <rect x="12.25" y="19" width="5.5" height="6" rx="1" fill="var(--task-review)" />
        <rect x="19" y="12.5" width="5.5" height="12.5" rx="1" fill="var(--task-done)" />
      </g>
    </svg>
  );
}
