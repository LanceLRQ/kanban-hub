import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn/ui 约定的类名合并：先用 clsx 拼接条件类，再用 tailwind-merge 去重冲突的 Tailwind 类 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
