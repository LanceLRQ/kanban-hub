/*
 * 字节数的易读写法：设置页的存储占用等处使用。与 CLI 侧 kh 输出的大小写法
 * （packages/cli/src/repo/config.ts 的 formatByteSize）用途不同、不共享：那边要求
 * 能整除才换单位（配置输入要可逆），这边面向人读，保留一位小数。
 */

/** 不足 1 KB 用 B，之后依次 KB/MB/GB/TB；保留一位小数，整数位到三位起四舍五入到整数 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}
