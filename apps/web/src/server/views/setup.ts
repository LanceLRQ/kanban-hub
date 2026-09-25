import type { Services } from "@/server/services";
import { toMachineView, type MachineView } from "@/server/api/machine-view";

/**
 * 服务地址没有配置（`services.publicUrl` 为 null）时，用来推断的请求来源信息：
 * 优先取反向代理写入的转发头，没有时退回 `Host`。三个字段都可能为 null（直连、没有转发头）。
 */
export interface RequestOrigin {
  forwardedProto: string | null;
  forwardedHost: string | null;
  host: string | null;
}

export interface SetupView {
  /** 装进命令里的服务地址：`services.publicUrl` 优先，没配置时按请求来源推断 */
  publicUrl: string;
  /** 当前用户的机器列表，按接入（创建）时间从早到晚排序 */
  machines: MachineView[];
}

/**
 * 接入页要用到的数据：服务地址（用于拼装安装/登录命令）+ 当前用户的机器列表。
 * `userId` 用于过滤机器列表——同一台服务可能有多个用户，接入页只关心自己的机器。
 */
export function buildSetupView(services: Services, userId: string, requestOrigin: RequestOrigin): SetupView {
  const publicUrl = services.publicUrl ?? inferPublicUrl(requestOrigin);

  const machines = services.store.auth
    .listMachines()
    .filter((machine) => machine.userId === userId)
    .map(toMachineView)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));

  return { publicUrl, machines };
}

/** 含空白或 C0/DEL 控制字符：一律拒绝，不依赖 `new URL()` 的静默清洗（它会悄悄剥掉换行等字符） */
const CONTROL_OR_WHITESPACE = /[\s\x00-\x1f\x7f]/;

/** 转发头可能是逗号分隔的多个值（经过多层代理），规范只信第一个；两端空白顺便去掉 */
function firstHeaderValue(value: string | null): string | null {
  if (value === null) return null;
  const first = (value.split(",")[0] ?? "").trim();
  return first.length > 0 ? first : null;
}

/**
 * 优先用转发头（反向代理场景），没有转发头时退回 Host；两者都没有、或拼出来的地址不合法
 * （协议不是 http/https、含空白控制字符、`new URL()` 解析失败）时给空串——组件据此改用占位符，
 * 不会把没清洗过的请求头原样拼进用户要复制执行的命令。只取 `origin`：路径、查询、片段一律丢弃。
 */
function inferPublicUrl(origin: RequestOrigin): string {
  const host = firstHeaderValue(origin.forwardedHost) ?? firstHeaderValue(origin.host);
  if (host === null) return "";
  const proto = firstHeaderValue(origin.forwardedProto) ?? "http";

  if (CONTROL_OR_WHITESPACE.test(proto) || CONTROL_OR_WHITESPACE.test(host)) return "";

  let url: URL;
  try {
    url = new URL(`${proto}://${host}`);
  } catch {
    return "";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "";
  return url.origin;
}
