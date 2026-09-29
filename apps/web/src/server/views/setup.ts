import type { Services } from "@/server/services";
import { toMachineView, type MachineView } from "@/server/api/machine-view";
import { resolvePublicUrl, type RequestOrigin } from "@/server/web/public-url";

export interface SetupView {
  /** 装进命令里的服务地址：配置优先，没配置时按请求来源推断；推断不出来为空串（组件改用占位符） */
  publicUrl: string;
  /** 当前用户的机器列表，按接入（创建）时间从早到晚排序 */
  machines: MachineView[];
}

/**
 * 接入页要用到的数据：服务地址（用于拼装安装/登录命令）+ 当前用户的机器列表。
 * `userId` 用于过滤机器列表——同一台服务可能有多个用户，接入页只关心自己的机器。
 */
export function buildSetupView(services: Services, userId: string, requestOrigin: RequestOrigin): SetupView {
  const publicUrl = resolvePublicUrl(services.publicUrl, requestOrigin) ?? "";

  const machines = services.store.auth
    .listMachines()
    .filter((machine) => machine.userId === userId)
    .map(toMachineView)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));

  return { publicUrl, machines };
}
