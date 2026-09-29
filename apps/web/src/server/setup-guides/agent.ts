import { COMMON_RULES, missingAddressNotice, serverAddress } from "./shared";

/**
 * 下发给 agent 读的“接入本机”说明。`publicUrl` 为 null 时正文里用占位符，并要求 agent 先问用户。
 */
export function renderAgentGuide(publicUrl: string | null): string {
  const server = serverAddress(publicUrl);
  return `# 把本机接入 kanban-hub

${missingAddressNotice(publicUrl)}你正在帮用户把这台机器接入 kanban-hub（多项目进度看板）。按下面的编号步骤依次执行。

${COMMON_RULES}

## 1. 确认运行环境

需要 Node 22 及以上，以及 git：

\`\`\`bash
node --version
git --version
\`\`\`

Node 版本低于 22，或者没有 git，停下来告诉用户，等用户处理好再继续。

## 2. 安装 kh

\`\`\`bash
npm i -g ${server}/setup/kh.tgz
\`\`\`

遇到权限错误（例如 EACCES）时，先问用户想怎么处理，不要擅自使用 sudo。

## 3. 核对版本

\`\`\`bash
kh --version
curl -s ${server}/api/health
\`\`\`

\`kh --version\` 输出的版本号要与 \`/api/health\` 返回 JSON 里的 \`version\` 一致。不一致时，重新执行第 2 步；仍然不一致，把两个版本号告诉用户。

## 4. 登录

用户发给你的话里带有配对码，10 分钟内有效：

\`\`\`bash
kh login --server ${server} --code <配对码>
\`\`\`

配对码已经过期，或者用户的话里没有配对码：请用户在浏览器打开 \`${server}/setup\`，重新生成一个，再执行上面的命令。

## 5. 安装 skill 与 hook

先只看计划，不写任何文件：

\`\`\`bash
kh setup --dry-run
\`\`\`

把计划原样给用户看（会写哪些文件、是否修改 Claude Code 的 settings.json）。**先问用户**是否同意；得到确认后再执行：

\`\`\`bash
kh setup --yes
\`\`\`

## 6. 接入当前仓库

当前目录是一个 git 仓库时，**先问用户**要不要接着把这个仓库接入 kanban-hub。用户同意的话，读取并按 \`${server}/setup/migrate.md\` 的步骤继续。

## 常见退出码

| 退出码 | 含义 | 处理 |
|---|---|---|
| 3 | 未登录或令牌失效 | 请用户到 \`${server}/setup\` 重新生成配对码，再执行第 4 步 |
| 4 | 服务端连不上 | 检查服务端地址和网络，把错误输出告诉用户 |
| 6 | 版本不兼容 | 重新执行第 2 步安装与服务端一致的版本 |
`;
}
