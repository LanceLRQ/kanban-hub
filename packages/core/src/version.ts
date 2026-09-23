/** kanban-hub 的版本号。服务端、kh 命令行、网页共用这一个来源。 */
export const KH_VERSION = "0.1.0";

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

function parseVersion(version: string): ParsedVersion | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * 判断 kh 命令行的版本与服务端版本是否兼容。
 * 主版本号为 0 时要求次版本号相同；否则只要求主版本号相同。
 */
export function isCompatibleVersion(client: string, server: string): boolean {
  const c = parseVersion(client);
  const s = parseVersion(server);
  if (!c || !s) return false;
  if (c.major !== s.major) return false;
  return c.major !== 0 || c.minor === s.minor;
}
