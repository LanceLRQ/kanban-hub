# kanban-hub

> a multi-project kanban for vibe coding

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

> ⚠️ 项目处于设计阶段，尚无可用版本。

## 简介

同时推进多个项目、让 AI 编码助手（如 Claude Code）在终端里干活时，进度散落在各个仓库里，很难一眼看全。kanban-hub 是一个常驻在本机或内网服务器上的轻量服务：把多个仓库的开发进度汇总到一个网页里，同时可以直接浏览各仓库中的设计文档和 HTML demo。

进度数据就是仓库里的文件，AI 直接编辑文件即可更新进度；改动随 git 走，能 diff、能回滚。

## 特性（规划中）

- **多项目总览**：一个页面查看所有已注册项目的阶段与进行中的事项
- **进度即文件**：进度存放在各仓库内，AI 与人都通过编辑文件更新，无需额外数据库
- **不侵入仓库**：不往被管理的仓库里安装依赖、不改 agent 指令文件、不装 git hook
- **文档浏览**：渲染仓库内的 Markdown 文档，HTML demo 可直接打开
- **常驻服务**：以 systemd 服务运行，局域网内用浏览器访问，带鉴权

## 安装

尚未发布，敬请关注。

## 使用

尚未发布，敬请关注。

## 贡献

欢迎提 Issue 讨论需求与设计。项目尚在设计阶段，提交 PR 前请先开 Issue 沟通。

## License

MIT — 详见 [LICENSE](./LICENSE)。
