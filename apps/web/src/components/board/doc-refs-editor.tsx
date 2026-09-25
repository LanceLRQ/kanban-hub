"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { XIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { isPlainEnter } from "./editable-text";

interface DocRefsEditorProps {
  paths: string[];
  /** 以整个路径列表保存；返回 false 表示失败 */
  onChange: (next: string[]) => Promise<boolean>;
}

/** 关联文档：仓库内相对路径的列表，可以增删（路径格式由服务端校验，出错时逐条提示） */
export function DocRefsEditor({ paths, onChange }: DocRefsEditorProps) {
  const t = useTranslations("board");
  const [adding, setAdding] = useState("");

  async function add() {
    const path = adding.trim();
    if (path === "") return;
    if (paths.includes(path)) {
      setAdding("");
      return;
    }
    const ok = await onChange([...paths, path]);
    if (ok) setAdding("");
  }

  return (
    <div className="flex flex-col gap-2">
      {paths.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {paths.map((path) => (
            <span key={path} className="kh-doc-chip inline-flex items-center gap-1 rounded-[3px] border-[1.5px] border-border bg-background py-0.5 pr-1 pl-2 font-mono text-xs font-bold">
              {path}
              <button
                type="button"
                aria-label={t("sheet.docRefsRemove", { path })}
                onClick={() => void onChange(paths.filter((p) => p !== path))}
                className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
              >
                <XIcon className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <Input
        value={adding}
        aria-label={t("sheet.docRefsAddPlaceholder")}
        placeholder={t("sheet.docRefsAddPlaceholder")}
        onChange={(e) => setAdding(e.target.value)}
        onKeyDown={(e) => {
          if (isPlainEnter(e)) void add();
        }}
        className="kh-sheet-field h-8 bg-card font-mono text-xs md:text-xs"
      />
    </div>
  );
}
