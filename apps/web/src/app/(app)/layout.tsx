import type { ReactNode } from "react";
import { authedPageServices } from "@/server/web/services";
import { TopBar } from "@/components/shell/topbar";
import { LiveRefresh } from "@/components/live/live-refresh";

/** 需要登录的页面共用的外壳：校验会话（未登录跳到登录页）、渲染顶栏、维护一条 SSE 连接。 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const { services, user } = await authedPageServices();

  return (
    <>
      <TopBar user={user} now={services.now()} />
      <LiveRefresh />
      <main className="mx-auto max-w-[1240px] px-8 py-8">{children}</main>
    </>
  );
}
