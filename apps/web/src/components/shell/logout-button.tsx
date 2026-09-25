"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/client/api";

export function LogoutButton({ label }: { label: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function handleLogout(): Promise<void> {
    setPending(true);
    try {
      await apiRequest("/api/v1/auth/logout", { method: "POST" });
    } catch {
      // 登出请求本身失败也照常跳转登录页：服务端不保存会话状态，cookie 过期后效果一样
    } finally {
      router.push("/login");
      router.refresh();
    }
  }

  return (
    <Button variant="outline" size="sm" disabled={pending} onClick={() => void handleLogout()}>
      {label}
    </Button>
  );
}
