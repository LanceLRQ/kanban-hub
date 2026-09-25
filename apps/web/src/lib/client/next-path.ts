/**
 * 登录页 `next` 参数的校验：只接受站内相对路径，防止开放重定向。
 *
 * 规则（比“以 / 开头、不以 // 开头”更严格，堵住反斜杠和编码绕过）：
 * - 必须以单个 `/` 开头；
 * - 第二个字符是 `/` 或 `\` 的一律拒绝——`/\evil.com`、`//evil.com` 这类值会被
 *   支持特殊 scheme（http/https）的 WHATWG URL 解析成协议相对 URL，跳到外站；
 * - 整个值只要包含反斜杠、空白（含制表符、换行）或控制字符就拒绝；
 * - 上面两条对原始值和 URL 解码后的值都要各查一遍，防止 `%2F%2Fevil.com`、
 *   `%5Cevil.com` 这类编码绕过；解码失败（不是合法的百分号编码）同样拒绝。
 * 不满足任意一条就退回默认路径 `/`。
 */
export function sanitizeNextPath(raw: string | null | undefined): string {
  if (!raw) return "/";
  if (!isSafeNextPath(raw)) return "/";

  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return "/";
  }
  if (!isSafeNextPath(decoded)) return "/";

  return raw;
}

/** 反斜杠、空白（`\s` 含制表符/换行）、C0 控制字符、DEL，出现在任意位置都不允许 */
const UNSAFE_CHAR_PATTERN = /[\\\s\u0000-\u001f\u007f]/;

function isSafeNextPath(value: string): boolean {
  if (value.length === 0) return false;
  if (value[0] !== "/") return false;
  if (value[1] === "/" || value[1] === "\\") return false;
  return !UNSAFE_CHAR_PATTERN.test(value);
}
