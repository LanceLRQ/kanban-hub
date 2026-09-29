/**
 * 顶栏导航按当前路径决定高亮哪一项，纯函数便于单独测试。
 * 首页（`/`，待你处理）不在导航里，只能点 logo 进入，所以没有高亮项。
 * 项目页（`/p/*`，看板/时间线/设置都在项目自己的标签栏里切换）归到“项目”名下——用户是从
 * 项目列表进来的；`/setup` 是从“设置”页进入的接入引导，也算在“设置”名下。
 */
export function resolveActiveNavHref(pathname: string): string | null {
  if (pathname === "/projects" || pathname.startsWith("/p/")) return "/projects";
  if (pathname === "/timeline" || pathname.startsWith("/timeline/")) return "/timeline";
  if (
    pathname === "/settings" ||
    pathname.startsWith("/settings/") ||
    pathname === "/setup" ||
    pathname.startsWith("/setup/")
  ) {
    return "/settings";
  }
  return null;
}
