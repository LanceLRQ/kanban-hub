import { requirePageUser } from "@/server/web/session";

/** 看板标签：标签栏右侧没有内容 */
export default async function BoardTabsAside() {
  await requirePageUser();
  return null;
}
