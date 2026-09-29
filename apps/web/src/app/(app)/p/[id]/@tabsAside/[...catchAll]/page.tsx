import { requirePageUser } from "@/server/web/session";

/**
 * 时间线、设置等没有标签栏右侧内容的子页：显式渲染空内容。并行路由在客户端切换时会保留
 * 插槽上一次的内容，不兜住的话从文档切到别的标签，机器切换还会留在标签栏上。
 */
export default async function EmptyTabsAside() {
  await requirePageUser();
  return null;
}
