import Link from "next/link";
import { cn } from "@/lib/utils";
import { docPageHref } from "@/lib/doc-url";
import type { DocsMachineOption } from "@/server/views/docs";
import "./docs.css";

/**
 * 文档页的机器切换：每台同步过文档的机器一个标签，后面跟选中机器的同步时间。
 * 放在项目标签栏右侧（经项目布局的 `tabsAside` 插槽渲染）；切换机器时保留当前文件路径，
 * 没有路径时由目标机器按默认规则选文件。没有机器时不渲染。
 */
export function DocsMachinePicker({
  projectId,
  machines,
  path,
}: {
  projectId: string;
  machines: DocsMachineOption[];
  path?: string;
}) {
  if (machines.length === 0) return null;
  const selected = machines.find((m) => m.selected);
  return (
    <div className="kh-doc-machine-picker ml-auto flex flex-wrap items-center justify-end gap-2">
      {machines.map((m) => (
        <Link
          key={m.id}
          href={docPageHref(projectId, path, { machineId: m.id })}
          data-active={m.selected ? "true" : undefined}
          className={cn(
            "kh-doc-machine-chip rounded-sm border border-border px-2 py-1 font-mono text-xs",
            m.selected ? "bg-secondary text-secondary-foreground" : "bg-card text-foreground hover:bg-accent",
          )}
        >
          {m.name}
        </Link>
      ))}
      {selected?.lastSyncAtLabel && <span className="font-mono text-xs text-muted-foreground">{selected.lastSyncAtLabel}</span>}
    </div>
  );
}
