# kanban-hub

> a multi-project kanban for vibe coding

## 项目一句话定义

kanban-hub 是一个自托管的多项目进度看板服务：AI 编码助手通过命令行工具 `kh` 上报各项目“做到哪个阶段、哪个任务、什么状态”，人在一个网页里查看所有项目的进度，并浏览各仓库的设计文档和 HTML demo。

- 是：多项目进度总览 + 跨机器的仓库文档浏览器。
- 不是：AI 编码工作区（不负责拉起 agent 执行任务），也不是通用项目管理系统。

完整设计见 [`docs/superpowers/specs/2026-09-23-kanban-hub-design.md`](docs/superpowers/specs/2026-09-23-kanban-hub-design.md)。

## 核心设计要点

- **服务端统一管理进度**：AI 通过 `kh` 调 API 上报结构化状态，不解析仓库里的 Markdown 进度文件。进度不在仓库里，开源项目不会因此暴露开发进度。
- **存储用文件 + git，不用数据库**：数据是 YAML / JSONL 文件，数据目录本身是一个 git 仓库；支持手动打包 AES-256 加密备份。存储细节封装在单一的存储模块里。
- **`kh` 是唯一接触仓库的组件**：它把仓库里的文档增量推送到服务端保存快照，服务端不读任何仓库磁盘，所以能跨多台机器使用。
- **不侵入被管理的仓库**：`kh` 只在仓库里写 `.kanban-hub/`（默认通过 `.git/info/exclude` 本地排除），其余一律只读。
- **看板模型**：项目（周期、健康度、当前焦点）→ 容器（阶段 / 特性 / 杂项）→ 任务（状态、待你处理、分组标签、清单、日期），另有事件时间线。
- **通用 AI 接入**：Agent Skills 标准格式的 skill 加上 `kh` 命令行，任何 agent 都能用；Claude Code 另有 hook 自动同步文档、注入进度。

## 技术栈

- **服务端 + 网页**：Next.js（App Router，standalone 输出）、TypeScript、zod
  - Next.js 16 与多数模型的训练数据差异较大：写 Next 相关代码前，先读 `node_modules/next/dist/docs/` 里对应的文档。`next.config.ts` 设置了 `agentRules: false`，`next dev` 不会自动生成 `AGENTS.md` / `CLAUDE.md`。
- **UI**：shadcn/ui + Tailwind CSS + lucide 图标、next-intl
- **命令行**：`kh`，TypeScript，esbuild 打包成单文件，要求 Node 22 及以上
- **工程**：pnpm monorepo、Vitest
- **部署**：Docker Compose（生产用构建好的镜像，开发时挂载源码热更新）

## 实现现状

- [x] 调研：同类项目评估完成，确定自建
- [x] 设计定稿：见上方规格
- [ ] 实施：进行中（M0 工程骨架、M1 核心模型与存储、M2 鉴权与看板 API、M3 kh 基础命令、M4 网页看板已完成）

## 仓库结构

仓库结构：

```
kanban-hub/
├── CLAUDE.md              # 本文件：项目定义与约定（面向 AI 会话）
├── README.md              # 项目介绍（面向外部读者）
├── LICENSE                # MIT
├── apps/web/              # Next.js：API 处理函数 + 网页；src/server/store/ 是唯一读写数据目录的存储模块
│   ├── src/server/{auth,api,views,web}/         # 鉴权原语、apiRoute 外壳与服务容器、/api/v1 路由实现、页面用的视图构建函数、页面会话与取数的公共函数
│   ├── src/app/api/v1/、src/app/(app)/、src/app/login/  # API 路由；需要登录的页面（布局统一校验会话）；登录页
│   ├── src/{components,lib,i18n,styles}/        # 页面组件（按区域分目录）；纯函数（时间、偏好、客户端请求等）；next-intl 配置；主题 token 与字体样式
│   ├── messages/zh-CN/                          # next-intl 文案，按命名空间分文件；枚举中文名在 enums.json
│   └── src/app/setup/kh.tgz/、src/kh-e2e/       # 下发 kh 安装包的路由；kh 端到端测试（进程内测试服务端）
├── packages/core/         # zod schema 与纯逻辑，不做 IO，按模块子路径导入（如 @kanban-hub/core/schema）；版本号的唯一来源
├── packages/cli/          # kh 命令行（esbuild 打包成单文件）
│   └── src/{commands,repo,http,config,status}/  # 各子命令、仓库本地操作、HTTP 客户端、本机配置、status 视图渲染
├── Dockerfile             # deps / build / dev / runtime 四阶段
├── docker/                # 容器入口脚本
├── docker-compose.dev.yml # 开发：挂载源码，热更新
├── deploy/                # 生产：docker-compose.yml、.env.example
└── docs/
    └── superpowers/specs/ # 定稿后可公开的设计规格
```

`docs/_internal/`、`CLAUDE.local.md`、`.claude/` 是本地私有的开发过程资料，已被 `.gitignore` 排除，不入库。新增文档时，过程性内容（讨论、计划、审查、原型）放 `docs/_internal/`，不要写进公开文档。

## 常用命令

```bash
pnpm install                     # 安装依赖（pnpm 11；新增的构建脚本要在 pnpm-workspace.yaml 的 allowBuilds 里放行）
pnpm test                        # 全部测试（Vitest，按包拆成多个项目）
pnpm typecheck                   # 类型检查（web 会先执行 next typegen）
pnpm lint                        # eslint
pnpm dev                         # 在本机直接启动开发服务：http://127.0.0.1:28970，数据写在 dev-data/
pnpm -F @kanban-hub/web build     # web 的生产构建；会先收集字体许可证（写到 apps/web/public/licenses/），再执行 next build
pnpm -F @kanban-hub/cli build    # 把 kh 打包到 packages/cli/dist/kh.mjs
pnpm -F @kanban-hub/cli run pack:tgz   # 打包 kh 安装包到 packages/cli/dist/kh.tgz（开发服务的 /setup/kh.tgz 下发它）

# Docker 开发（挂载源码热更新）
mkdir -p dev-data/data dev-data/backups
PUID=$(id -u) PGID=$(id -g) docker compose -f docker-compose.dev.yml up --build

# Docker 生产
cd deploy && cp .env.example .env    # 填写 KH_ADMIN_PASSWORD、PUID、PGID
mkdir -p data backups && docker compose up -d --build
```
