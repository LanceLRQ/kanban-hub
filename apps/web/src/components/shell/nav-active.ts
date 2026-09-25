/**
 * 顶栏导航按当前路径决定高亮哪一项，纯函数便于单独测试。
 * 项目页（`/p/*`，看板/时间线/设置都在项目自己的标签栏里切换）在顶栏导航里归到“总览”名下——
 * 用户是从总览的项目卡片进来的，`/setup` 是从“设置”页进入的接入引导，也算在“设置”名下。
 */
export function resolveActiveNavHref(pathname: string): string {
  if (pathname.startsWith("/p/")) return "/";
  if (pathname === "/timeline" || pathname.startsWith("/timeline/")) return "/timeline";
  if (
    pathname === "/settings" ||
    pathname.startsWith("/settings/") ||
    pathname === "/setup" ||
    pathname.startsWith("/setup/")
  ) {
    return "/settings";
  }
  return "/";
}
