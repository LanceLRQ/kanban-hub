/** 跳过的文件大小：字节数格式化成 "20.0 MB" 这样的可读文本，1000 进制（跟 kh 的提示口径一致） */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1000;
  let unitIndex = 0;
  while (value >= 1000 && unitIndex < units.length - 1) {
    value /= 1000;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}
