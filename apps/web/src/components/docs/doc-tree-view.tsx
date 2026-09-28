import Link from "next/link";
import { FileIcon, FolderIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DocTreeNode } from "@/lib/doc-tree";

interface DocTreeViewProps {
  nodes: DocTreeNode[];
  /** 当前打开的文件路径（仓库相对），高亮对应的树节点 */
  currentPath: string | null;
  /** 由文件路径构造文档页链接（带上当前的 ?m=） */
  hrefFor: (path: string) => string;
}

export function DocTreeView({ nodes, currentPath, hrefFor }: DocTreeViewProps) {
  if (nodes.length === 0) return null;
  return (
    <ul className="kh-doc-tree flex flex-col text-sm">
      {nodes.map((node) => (
        <DocTreeItem key={node.path} node={node} currentPath={currentPath} hrefFor={hrefFor} depth={0} />
      ))}
    </ul>
  );
}

interface DocTreeItemProps {
  node: DocTreeNode;
  currentPath: string | null;
  hrefFor: (path: string) => string;
  depth: number;
}

function DocTreeItem({ node, currentPath, hrefFor, depth }: DocTreeItemProps) {
  const indent = { paddingLeft: `${depth * 14 + 8}px` };

  if (node.type === "dir") {
    return (
      <li>
        <div className="kh-doc-tree-dir flex items-center gap-1.5 py-1 text-xs font-bold tracking-wide text-muted-foreground" style={indent}>
          <FolderIcon className="size-3.5 shrink-0" />
          <span className="truncate">{node.name}</span>
        </div>
        <ul className="flex flex-col">
          {node.children.map((child) => (
            <DocTreeItem key={child.path} node={child} currentPath={currentPath} hrefFor={hrefFor} depth={depth + 1} />
          ))}
        </ul>
      </li>
    );
  }

  const active = node.path === currentPath;
  return (
    <li>
      <Link
        href={hrefFor(node.path)}
        data-active={active ? "true" : undefined}
        className={cn(
          "kh-doc-tree-item flex items-center gap-1.5 rounded-sm py-1 text-foreground hover:bg-accent",
          active && "bg-secondary text-secondary-foreground hover:bg-secondary",
        )}
        style={indent}
      >
        <FileIcon className="size-3.5 shrink-0" />
        <span className="truncate">{node.name}</span>
      </Link>
    </li>
  );
}
