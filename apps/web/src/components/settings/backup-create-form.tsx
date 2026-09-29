"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { ApiRequestError, apiRequest } from "@/lib/client/api";
import { sanitizeNextPath } from "@/lib/client/next-path";

export interface BackupCreateLabels {
  passwordPlaceholder: string;
  includeHistory: string;
  createButton: string;
  creating: string;
}

/** 创建表单的展示部分：状态全部由 props 给出，不读翻译与路由，静态渲染即可测试 */
export function BackupCreateFields({
  password,
  onPasswordChange,
  includeGit,
  onIncludeGitChange,
  pending,
  onCreate,
  labels,
}: {
  password: string;
  onPasswordChange: (value: string) => void;
  includeGit: boolean;
  onIncludeGitChange: (value: boolean) => void;
  pending: boolean;
  onCreate: () => void;
  labels: BackupCreateLabels;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      {/* 密码只在这一个框里存在：不上 autofill、不进任何日志 */}
      <Input
        type="password"
        autoComplete="new-password"
        maxLength={128}
        disabled={pending}
        value={password}
        onChange={(e) => onPasswordChange(e.target.value)}
        placeholder={labels.passwordPlaceholder}
        className="max-w-64"
      />
      <label className="flex items-center gap-1.5 text-sm">
        <Checkbox disabled={pending} checked={includeGit} onCheckedChange={(v) => onIncludeGitChange(v === true)} />
        {labels.includeHistory}
      </label>
      <Button type="button" size="sm" disabled={pending} onClick={onCreate}>
        {pending ? labels.creating : labels.createButton}
      </Button>
    </div>
  );
}

/**
 * 创建备份：留空 = 不加密（不发空字符串）；进行中禁用表单并提示，完成后 router.refresh()
 * 让服务端组件重读备份列表。
 */
export function BackupCreateForm() {
  const t = useTranslations("settings");
  const tc = useTranslations("common");
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [includeGit, setIncludeGit] = useState(true);
  const [pending, setPending] = useState(false);

  async function handleCreate(): Promise<void> {
    setPending(true);
    try {
      const body: { password?: string; includeGit: boolean } = { includeGit };
      if (password) body.password = password;
      await apiRequest("/api/v1/backups", { method: "POST", body });
      router.refresh();
    } catch (e) {
      if (!(e instanceof ApiRequestError)) throw e;
      if (e.status === 401) {
        // 会话过期：回登录页，登录后回到设置页（与 useMutation 的处理一致）
        const next = sanitizeNextPath(window.location.pathname + window.location.search);
        router.push(`/login?next=${encodeURIComponent(next)}`);
      } else if (e.status === 0) {
        toast.error(tc("api.networkError"));
      } else if (e.code === null) {
        toast.error(tc("api.unexpectedResponse"));
      } else {
        // 服务端业务错误本身就是中文提示（409 已有备份在进行中、400 密码超长等），
        // 这里不用 useMutation 的通用冲突文案，直接展示服务端的话
        toast.error(e.message);
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <BackupCreateFields
      password={password}
      onPasswordChange={setPassword}
      includeGit={includeGit}
      onIncludeGitChange={setIncludeGit}
      pending={pending}
      onCreate={() => void handleCreate()}
      labels={{
        passwordPlaceholder: t("backup.passwordPlaceholder"),
        includeHistory: t("backup.includeHistory"),
        createButton: t("backup.createButton"),
        creating: t("backup.creating"),
      }}
    />
  );
}
