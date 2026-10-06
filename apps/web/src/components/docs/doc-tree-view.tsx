"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { ChevronRightIcon, ChevronsDownUpIcon, ChevronsUpDownIcon, FileIcon, FolderIcon } from "lucide-react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLocalView } from "@/lib/client/use-local-view";
import { allDirPaths, ancestorDirs, compileMatcher, filterTree, highlightRange } from "@/lib/doc-tree-filter";
import type { DocTreeNode } from "@/lib/doc-tree";
import { docPageHref } from "@/lib/doc-url";
import { cn } from "@/lib/utils";
import { scrollTopToReveal } from "./doc-sidebar-panel";

interface DocTreeViewProps {
  projectId: string;
  /** 当前选中的机器，链接里带上 ?m=；没有选中时不带 */
  machineId: string | undefined;
  nodes: DocTreeNode[];
  /** 当前打开的文件路径（仓库相对），高亮对应的树节点 */
  currentPath: string | null;
}

/** 展开的目录路径；null 表示本地还没有记录（此时只展开当前文件的目录链） */
const expandedSchema = z.array(z.string()).nullable();

/**
 * 文档树：目录可折叠，工具栏提供路径搜索（可选正则）与全部展开/收起。
 * 展开集合按项目存在本地；搜索时命中的文件及其祖先目录全部展开，不读也不改存储的展开集合。
 * 树自己横向滚动，工具栏留在滚动区域之外。
 */
export function DocTreeView({ projectId, machineId, nodes, currentPath }: DocTreeViewProps) {
  const t = useTranslations("docs.tree");
  const [stored, setStored] = useLocalView(`kh-doc-tree:${projectId}`, expandedSchema, null);
  const [query, setQuery] = useState("");
  const [regex, setRegex] = useState(false);
  // 搜索时被手动收起的目录：只存在内存里，查询或正则开关变化时清空，不碰存储的展开集合
  const [searchCollapsed, setSearchCollapsed] = useState<ReadonlySet<string>>(new Set());
  const rootRef = useRef<HTMLDivElement>(null);
  // 已经把哪个文件的目录链并入过展开集合；用户手动折叠祖先目录后不能再被自动展开
  const mergedFor = useRef<string | null>(null);

  const matcher = useMemo(() => compileMatcher(query, regex), [query, regex]);
  const filtered = useMemo(() => (matcher.ok && matcher.test ? filterTree(nodes, matcher.test) : null), [matcher, nodes]);

  const expanded = useMemo(() => {
    if (filtered) return new Set(allDirPaths(filtered.nodes).filter((dir) => !searchCollapsed.has(dir)));
    return new Set(stored ?? (currentPath ? ancestorDirs(currentPath) : []));
  }, [filtered, stored, currentPath, searchCollapsed]);

  // 打开新文件时，把它的祖先目录并入已保存的展开集合，保证它可见
  useEffect(() => {
    if (stored === null || currentPath === null || mergedFor.current === currentPath) return;
    mergedFor.current = currentPath;
    const missing = ancestorDirs(currentPath).filter((dir) => !stored.includes(dir));
    if (missing.length > 0) setStored([...stored, ...missing]);
  }, [stored, currentPath, setStored]);

  // 水合后读到本地的展开集合，可能让当前文件所在的行移位；这里再把它滚进面板的可见范围
  const hasStored = stored !== null;
  useEffect(() => {
    const item = rootRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    const body = item?.closest<HTMLElement>(".kh-doc-panel-body");
    if (!item || !body) return;
    const itemTop = item.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
    body.scrollTop = scrollTopToReveal({ itemTop, itemHeight: item.offsetHeight, viewHeight: body.clientHeight, scrollTop: body.scrollTop });
  }, [currentPath, hasStored]);

  const setExpanded = (next: Iterable<string>) => {
    if (filtered) {
      // 搜索中只改内存里的收起集合：展开 = 筛选后的目录 − 收起
      const keep = new Set(next);
      setSearchCollapsed(new Set(allDirPaths(filtered.nodes).filter((dir) => !keep.has(dir))));
      return;
    }
    // 用户改过展开状态后，以存储为准，不再自动并入当前文件的目录链
    mergedFor.current = currentPath;
    setStored([...next]);
  };
  const toggle = (path: string) => {
    const next = new Set(expanded);
    if (!next.delete(path)) next.add(path);
    setExpanded(next);
  };

  if (nodes.length === 0) return null;

  const shown = filtered ? filtered.nodes : nodes;
  return (
    <div ref={rootRef} className="kh-doc-tree-wrap">
      <div className="kh-doc-tree-toolbar sticky top-0 z-10 flex flex-col gap-1.5 pb-2">
        <div className="flex items-center gap-1">
          <Input
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSearchCollapsed(new Set());
            }}
            placeholder={t("search")}
            aria-label={t("search")}
            aria-invalid={!matcher.ok}
            className="h-7 px-2 text-xs md:text-xs"
          />
          <Button type="button" variant="ghost" size="icon-xs" aria-label={t("expandAll")} title={t("expandAll")} onClick={() => setExpanded(allDirPaths(nodes))}>
            <ChevronsUpDownIcon />
          </Button>
          <Button type="button" variant="ghost" size="icon-xs" aria-label={t("collapseAll")} title={t("collapseAll")} onClick={() => setExpanded([])}>
            <ChevronsDownUpIcon />
          </Button>
        </div>
        <div className="flex items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-1.5">
            <Checkbox id={`kh-doc-tree-regex-${projectId}`} checked={regex} onCheckedChange={(v) => {
                setRegex(v === true);
                setSearchCollapsed(new Set());
              }} className="size-3.5" />
            <Label htmlFor={`kh-doc-tree-regex-${projectId}`} className="text-xs font-normal">
              {t("regex")}
            </Label>
          </div>
          {!matcher.ok ? (
            <span className="text-destructive">{t("invalidRegex")}</span>
          ) : filtered ? (
            <span className="text-muted-foreground">{filtered.count > 0 ? t("matchCount", { count: filtered.count }) : t("noMatch")}</span>
          ) : null}
        </div>
      </div>
      <div className="kh-doc-tree-scroll overflow-x-auto">
        <ul className="kh-doc-tree flex w-max min-w-full flex-col text-sm">
          {shown.map((node) => (
            <DocTreeItem key={node.path} node={node} depth={0} {...{ projectId, machineId, currentPath, expanded, toggle, query, regex }} />
          ))}
        </ul>
      </div>
    </div>
  );
}

interface DocTreeItemProps {
  node: DocTreeNode;
  depth: number;
  projectId: string;
  machineId: string | undefined;
  currentPath: string | null;
  expanded: ReadonlySet<string>;
  toggle: (path: string) => void;
  query: string;
  regex: boolean;
}

function DocTreeItem(props: DocTreeItemProps) {
  const { node, depth, projectId, machineId, currentPath, expanded, toggle, query, regex } = props;
  const t = useTranslations("docs.tree");
  const indent = { paddingLeft: `${depth * 14 + 8}px` };

  if (node.type === "dir") {
    const open = expanded.has(node.path);
    return (
      <li>
        <button
          type="button"
          aria-expanded={open}
          aria-label={t(open ? "collapse" : "expand", { name: node.name })}
          onClick={() => toggle(node.path)}
          className="kh-doc-tree-dir flex w-full items-center gap-1.5 py-1 pr-2 text-left text-xs font-bold tracking-wide whitespace-nowrap text-muted-foreground hover:bg-accent"
          style={indent}
        >
          <ChevronRightIcon className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} aria-hidden="true" />
          <FolderIcon className="size-3.5 shrink-0" aria-hidden="true" />
          <span>{node.name}</span>
        </button>
        {open && (
          <ul className="flex flex-col">
            {node.children.map((child) => (
              <DocTreeItem key={child.path} {...props} node={child} depth={depth + 1} />
            ))}
          </ul>
        )}
      </li>
    );
  }

  const active = node.path === currentPath;
  return (
    <li>
      <Link
        href={docPageHref(projectId, node.path, { machineId })}
        data-active={active ? "true" : undefined}
        className={cn(
          "kh-doc-tree-item flex items-center gap-1.5 rounded-sm py-1 pr-2 whitespace-nowrap text-foreground hover:bg-accent",
          active && "bg-secondary text-secondary-foreground hover:bg-secondary",
        )}
        style={indent}
      >
        <FileIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <span>{highlighted(node.name, query, regex)}</span>
      </Link>
    </li>
  );
}

function highlighted(name: string, query: string, regex: boolean): ReactNode {
  const range = highlightRange(name, query, regex);
  if (!range) return name;
  return (
    <>
      {name.slice(0, range[0])}
      <mark className="kh-doc-tree-mark rounded-[2px] bg-primary/40 px-px text-inherit">{name.slice(range[0], range[1])}</mark>
      {name.slice(range[1])}
    </>
  );
}
