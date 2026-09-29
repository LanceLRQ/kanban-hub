/**
 * 文档页与 /raw 链接的构造：仓库相对路径逐段 encodeURIComponent 再拼接（不能整段编码，
 * 会把路径里的 `/` 也编码掉）；中文、空格、`#`、`?`、`%` 都要能在链接里正确往返。
 */

export function encodeDocPath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/**
 * 文档页 catch-all 路由拿到的路径段还原成仓库相对路径。Next 传给页面的 params 保留百分号编码
 * （路由处理函数拿到的是解码后的），不解码的话中文等非 ASCII 文件名对不上快照清单。
 * 不是合法编码的段原样保留。
 */
export function decodeDocPathParam(segments: string[] | undefined): string | undefined {
  if (!segments || segments.length === 0) return undefined;
  return segments
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");
}

/** 项目文档页链接；path 省略时是不带路径的文档首页；hash 为 null/undefined 时不带锚点 */
export function docPageHref(projectId: string, path?: string, opts: { machineId?: string; hash?: string | null } = {}): string {
  const base = `/p/${projectId}/docs${path ? `/${encodeDocPath(path)}` : ""}`;
  const query = opts.machineId ? `?m=${encodeURIComponent(opts.machineId)}` : "";
  const hash = opts.hash ? `#${opts.hash}` : "";
  return `${base}${query}${hash}`;
}

/** /raw 原文件链接 */
export function rawFileHref(token: string, path: string): string {
  return `/raw/${encodeURIComponent(token)}/${encodeDocPath(path)}`;
}
