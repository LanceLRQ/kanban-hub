# kanban-hub

> a multi-project kanban for vibe coding

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

> ⚠️ 项目处于设计阶段，尚无可用版本。

## 简介

同时推进多个项目、让 AI 编码助手在终端里干活时，进度散落在各个仓库里，很难一眼看全。kanban-hub 是一个自托管的服务：AI 通过命令行工具 `kh` 上报每个项目做到了哪个阶段、哪个任务，你在一个网页里查看所有项目的进度，并直接浏览各仓库里的设计文档和 HTML demo。

## 特性（规划中）

- **多项目总览**：一个页面查看所有项目的周期、健康度、当前焦点与进行中的任务，外加一个跨项目的“待你处理”收件箱
- **AI 自动上报**：提供符合 Agent Skills 标准的通用 skill，Claude Code、Codex、Gemini CLI、Cursor 等 agent 都能通过 `kh` 更新进度
- **阶段与特性**：开发期按阶段推进，迭代期按特性并行跟踪，另有储备池和杂项
- **跨机器文档浏览**：`kh` 把各台机器上仓库里的文档增量同步到服务端，Markdown 在线渲染，HTML demo 在沙箱中打开
- **不侵入仓库**：不往被管理的仓库里安装依赖、不改 `.gitignore`、不改 agent 指令文件、不装 git hook
- **无数据库**：数据是 YAML / JSONL 文件，由 git 记录历史，支持加密打包备份
- **Docker Compose 部署**：局域网内用浏览器访问，带鉴权

## 安装

尚未发布，敬请关注。

## 使用

尚未发布，敬请关注。

## 贡献

欢迎提 Issue 讨论需求与设计。项目尚在设计阶段，提交 PR 前请先开 Issue 沟通。

## License

MIT — 详见 [LICENSE](./LICENSE)。
