# kanban-hub

> a multi-project kanban for vibe coding

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

## 简介

同时推进多个项目、让 AI 编码助手在终端里干活时，进度散落在各个仓库里，很难一眼看全。kanban-hub 是一个自托管的服务：AI 通过命令行工具 `kh` 上报每个项目做到了哪个阶段、哪个任务，你在一个网页里查看所有项目的进度，并直接浏览各仓库里的设计文档和 HTML demo。

## 特性

- **多项目总览**：首页是跨项目的“待你处理”收件箱；项目列表页查看所有项目的周期、健康度、当前焦点与进度
- **AI 自动上报**：提供符合 Agent Skills 标准的通用 skill，Claude Code、Codex、Gemini CLI、Cursor 等 agent 都能通过 `kh` 更新进度；Claude Code 另有 hook 自动同步文档、注入进度
- **阶段与特性**：开发期按阶段推进，迭代期按特性并行跟踪，另有储备池和杂项
- **跨机器文档浏览**：`kh` 把各台机器上仓库里的文档增量同步到服务端，Markdown 在线渲染，HTML demo 在沙箱中打开
- **不侵入仓库**：不往被管理的仓库里安装依赖、不改 `.gitignore`、不改 agent 指令文件、不装 git hook
- **无数据库**：数据是 YAML / JSONL 文件，由 git 记录历史，支持加密打包备份与恢复
- **Docker 部署**：局域网内用浏览器访问，带鉴权

## 部署

### 一键安装（推荐）

在一台 Linux 机器上（装有 Docker 即可）：

```bash
curl -fsSL https://raw.githubusercontent.com/LanceLRQ/kanban-hub/main/deploy/kanban-hub.sh | bash
```

向导会依次确认安装目录、端口与监听地址、管理员密码（可随机生成）、时区、运行身份与对外地址，然后拉取镜像启动。之后在安装目录里用同一个脚本管理：

```bash
bash kanban-hub.sh          # 管理菜单
bash kanban-hub.sh status   # 查看运行状态
bash kanban-hub.sh upgrade  # 升级到最新版
bash kanban-hub.sh restore <备份文件名>   # 从备份恢复（原数据自动留存）
```

服务起来后打开网页完成接入：生成配对码，把接入页给出的那句话发给你的 AI 助手即可。

### 手动 Docker Compose

```bash
git clone https://github.com/LanceLRQ/kanban-hub.git && cd kanban-hub/deploy
cp .env.example .env    # 填写 KH_ADMIN_PASSWORD、PUID、PGID
mkdir -p data backups
docker compose up -d --build
```

### 不用 Docker

`pnpm build` 后用 node 直接运行 standalone 产物，配合 systemd 常驻；unit 示例与前置要求见 [`deploy/systemd/kanban-hub.service`](./deploy/systemd/kanban-hub.service)。

### 备份与恢复

网页设置页或 `kh backup` 创建加密备份（AES-256 zip，密码不保存），文件落在 `backups/`；恢复只能到空的数据目录（`docker compose run --rm kanban-hub restore /backups/<文件>`，或用一键脚本的 `restore` 命令，原数据自动留存）。

## 贡献

欢迎提 Issue 讨论需求与设计。提交 PR 前请先开 Issue 沟通。

## License

MIT — 详见 [LICENSE](./LICENSE)。
