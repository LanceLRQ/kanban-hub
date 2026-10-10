import fs from "node:fs/promises";
import path from "node:path";
import { SYNC_BUILTIN_IGNORE, SYNC_BUILTIN_MARKERS } from "@kanban-hub/core/sync";
import { isNoEntError, writeFileAtomic } from "../fs-utils";
import { REPO_CONFIG_DIR, REPO_IGNORE_FILE } from "./config";

const builtinLines = SYNC_BUILTIN_IGNORE.map((rule) => `#   ${rule}`).join("\n");
const markerLines = SYNC_BUILTIN_MARKERS.map((m) => `#   含 ${m.name} 的目录（${m.reason}）`).join("\n");

/** .kanban-hub/ignore 的初始内容：全是注释，写出后不改变任何同步结果 */
export const IGNORE_TEMPLATE = `# kanban-hub 同步忽略规则，写法与 .gitignore 相同。
# 匹配不分大小写（docs/Drafts/ 也会排除 docs/drafts/）。
# 每行一条规则：# 开头是注释，空行忽略；以 / 结尾表示目录；开头的 / 表示从仓库根开始匹配；
# 以 ! 开头表示把已被排除的路径加回来。后面的规则覆盖前面的。
#
# kh 已经按内置规则排除了这些目录和文件：
${builtinLines}
# 扫描时，下面这类目录也整个跳过：
${markerLines}
# 运行 kh sync --dry-run 可以预览将上传的文件数与按目录的汇总，以及哪些目录被跳过了。
#
# 例子：
#   追加排除一个目录：      docs/drafts/
#   排除某类文件：          *.log
#   把被内置规则排除的目录加回来：  !docs/vendor/venv/
#   把被识别为虚拟环境或嵌套仓库的目录加回来：  !docs/ref-repo/
#
# 这个文件位于 .kanban-hub/ 内，默认不进 git。要在多台机器间共享，执行：
#   git add -f .kanban-hub/ignore
`;

export function ignoreFilePath(root: string): string {
  return path.join(root, REPO_CONFIG_DIR, REPO_IGNORE_FILE);
}

async function ignoreFileExists(root: string): Promise<boolean> {
  try {
    await fs.stat(ignoreFilePath(root));
    return true;
  } catch (err) {
    if (isNoEntError(err)) return false;
    throw err;
  }
}

/** 忽略文件不存在时写出模板并返回 true；已存在（不论内容）时不动，返回 false */
export async function writeIgnoreTemplate(root: string): Promise<boolean> {
  if (await ignoreFileExists(root)) return false;
  await writeFileAtomic(ignoreFilePath(root), IGNORE_TEMPLATE, { mkdir: true });
  return true;
}

/** 注册计划里要列出的忽略文件路径：文件已存在时不会写，返回 null */
export async function planIgnoreTemplate(root: string): Promise<string | null> {
  return (await ignoreFileExists(root)) ? null : ignoreFilePath(root);
}
