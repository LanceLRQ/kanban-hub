/**
 * 服务地址没有配置（`services.publicUrl` 为 null）时，用来推断的请求来源信息：
 * 优先取反向代理写入的转发头，没有时退回 `Host`。三个字段都可能为 null（直连、没有转发头）。
 */
export interface RequestOrigin {
  forwardedProto: string | null;
  forwardedHost: string | null;
  host: string | null;
}

/** 允许出现在服务地址里的 host：域名或 IPv4（字母数字、点、连字符）或方括号 IPv6，可带 1-5 位端口 */
const HOST_PATTERN = /^([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(:\d{1,5})?$/;

/** 转发头可能是逗号分隔的多个值（经过多层代理），规范只信第一个；两端空白顺便去掉 */
function firstHeaderValue(value: string | null): string | null {
  if (value === null) return null;
  const first = (value.split(",")[0] ?? "").trim();
  return first.length > 0 ? first : null;
}

/**
 * 服务地址的唯一取法：配置的地址优先；没配置时用转发头，再退回 Host 推断；推断不出来返回 null，
 * 调用方据此改用占位符。地址会被拼进用户要复制执行的命令和下发给 agent 的引导文件，
 * 所以 host 必须严格匹配 {@link HOST_PATTERN}，协议只接受 http/https，
 * 路径、查询、片段、用户信息、空白与控制字符一律拒绝，不依赖 `new URL()` 的静默清洗。
 */
export function resolvePublicUrl(configured: string | null, origin: RequestOrigin): string | null {
  if (configured) return configured;

  const host = firstHeaderValue(origin.forwardedHost) ?? firstHeaderValue(origin.host);
  if (host === null || !HOST_PATTERN.test(host)) return null;

  const proto = (firstHeaderValue(origin.forwardedProto) ?? "http").toLowerCase();
  if (proto !== "http" && proto !== "https") return null;

  try {
    return new URL(`${proto}://${host}`).origin;
  } catch {
    return null;
  }
}
