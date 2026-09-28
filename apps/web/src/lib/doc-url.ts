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
