import fs from "node:fs/promises";

let tmpSeq = 0;

/**
 * 先写临时文件再重命名，保证不会留下写到一半的文件；mode 未指定时用系统默认权限。
 * 与 config/home.ts 里的写法一致，这里单独放一份是因为两边分属不同任务的文件归属。
 */
export async function writeFileAtomic(file: string, data: string, mode?: number): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${++tmpSeq}`;
  try {
    await fs.writeFile(tmp, data, mode !== undefined ? { encoding: "utf8", mode } : "utf8");
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

export function isNoEntError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === "ENOENT";
}
