import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * next-intl 用点号表达嵌套路径，所以语言包 JSON 文件里任何一层的键名本身都不能含点号
 * （例如 "project.created" 必须写成 { project: { created: ... } } 而不是字面量键
 * "project.created"），否则加载时会抛 INVALID_KEY。这里遍历 messages/zh-CN/ 下所有
 * 命名空间文件的每一层键，防止再出现字面量带点的键。
 */

const MESSAGES_DIR = path.join(__dirname, "../../messages/zh-CN");

function findDotKeys(value: unknown, pathSoFar: string): string[] {
  if (value === null || typeof value !== "object") return [];
  const found: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const here = pathSoFar ? `${pathSoFar}.${key}` : key;
    if (key.includes(".")) found.push(here);
    found.push(...findDotKeys(child, here));
  }
  return found;
}

const files = fs.readdirSync(MESSAGES_DIR).filter((f) => f.endsWith(".json"));

describe("语言包命名空间文件的键名不含点号", () => {
  it("messages/zh-CN 下至少能扫到已知的命名空间文件", () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  it.each(files)("%s 的所有键（递归）都不含点号", (file) => {
    const raw = fs.readFileSync(path.join(MESSAGES_DIR, file), "utf8");
    const data = JSON.parse(raw) as unknown;
    expect(findDotKeys(data, "")).toEqual([]);
  });
});
