# kanban-hub 设计规格

> 日期：2026-09-23
> 状态：已定稿，待审阅
> 范围：第一版（v1）

## 1. 目标

kanban-hub 是一个自托管的多项目进度看板服务，面向“让 AI 编码助手在终端里干活”的开发方式：

- 在一个网页里查看多个项目当前做到哪个阶段、哪个任务、什么状态；
- AI 通过通用命令行工具 `kh` 上报进度，人不需要手动维护看板；
- 在同一个网页里浏览各仓库的设计文档和 HTML demo，包括没有进 git 的私有文档；
- 不侵入被管理的仓库：不装依赖、不改 `.gitignore`、不改 agent 指令文件、不装 git hook。

## 2. 范围

### 2.1 第一版

- 服务端：文件 + git 存储、手动加密备份与恢复、密码登录与机器令牌、项目与机器登记
- 看板：项目周期、阶段 / 特性 / 杂项三类容器、任务（状态、待你处理、分组标签、清单、日期）、时间线
- 网页：总览与跨项目收件箱、项目看板（可编辑）、时间线、文档浏览、接入引导、备份
- 命令行 `kh`：接入、注册、看板操作、文档同步（推送）、跨机器读取和拉取文档、导入导出、备份
- AI 接入：通用 Agent Skill；Claude Code 的 hook 适配
- 部署：Docker Compose（生产 + 开发热更新）

### 2.2 推到第二版

- 定时备份、保留份数、云端备份（包括推送到 git 远程）
- 跨项目全文搜索
- AI 会话实时状态（“某项目正有 AI 在工作”）
- MCP 接入
- Claude Code 以外其他 agent 的 hook 适配
- 团队功能：邀请、项目成员与角色、私有文档可见范围、公网部署加固
- 一键安装脚本与管理菜单
- 英文界面
- 离线上报队列

### 2.3 不做

依赖关系图、统计图表（累积流图、燃尽图、周期时间）、自动规则、通知、文档的实时双向同步（跨机器只在会话开始时和手动执行时拉取，见 9.3）。

## 3. 术语

| 术语 | 含义 |
|---|---|
| 项目 | 一个被跟踪的代码仓库，可以在多台机器上有副本 |
| 机器 | 装了 `kh` 并登录过的一台电脑 |
| 位置 | 项目在某台机器上的仓库路径 |
| 容器 | 项目下承载任务的分组，分阶段、特性、杂项三类 |
| 周期 | 项目所处的大阶段：设计期、开发期、迭代期、维护期、归档 |
| 待你处理 | 任务上的标记，表示需要人来决策、验证或操作 |
| 快照 | 服务端保存的、某台机器上某个项目的文档副本 |

## 4. 架构

### 4.1 组件

```
开发机（Mac / Linux，可以多台）                      服务端（Docker Compose）
┌──────────────────────────────────┐          ┌───────────────────────────────────┐
│ AI agent（Claude Code、Codex 等） │          │ kanban-hub（Next.js standalone）   │
│  ├ skill  ~/.agents/skills/ 等    │          │  ├ /api/v1/*  令牌或会话鉴权        │
│  └ hooks  （仅 Claude Code）       │          │  ├ 网页       密码登录 + SSE 刷新   │
│        │ 调用                     │   HTTP   │  ├ 存储层     内存索引 + 单一写入队列│
│        ▼                          │ ───────▶ │  ├ 备份       AES-256 加密 zip     │
│ kh（Node 单文件）                 │          │  └ /raw       文档原文件，沙箱隔离   │
│  ├ 读 仓库/.kanban-hub/config.yaml │          │ 挂载卷：/data（git 仓库）          │
│  ├ 读 ~/.kanban-hub/              │          │         /backups                  │
│  └ 只读 仓库内同步范围的文件        │          └───────────────────────────────────┘
└──────────────────────────────────┘
```

`kh` 是唯一接触仓库的组件。服务端不读任何仓库磁盘，只接收 `kh` 推来的数据。

### 4.2 仓库结构

pnpm monorepo：

```
kanban-hub/
├── apps/web/              # Next.js（App Router，standalone 输出）：API 处理函数 + 网页
│   └── src/
│       ├── app/           # 页面与 route handlers
│       ├── components/    # shadcn/ui 与业务组件
│       ├── server/        # 服务端单例：存储、鉴权、同步、备份、SSE
│       ├── lib/           # 可测的纯判定逻辑（实现与 *.test.ts 并列）
│       └── i18n/          # next-intl 文案（第一版只有中文）
├── packages/core/         # zod schema 与纯逻辑，不做任何 IO
├── packages/cli/          # kh 命令行，esbuild 打包成单文件
│   └── assets/skill/      # 通用 SKILL.md
├── Dockerfile             # 多阶段构建：deps / build / dev / runtime
├── docker/                # 容器入口脚本
├── docker-compose.dev.yml # 开发：挂载源码，热更新
└── deploy/                # 生产：docker-compose.yml、.env.example
```

### 4.3 数据流

1. **上报进度**：AI 执行 `kh task set …`，请求发到 API。服务端用 zod 校验后放进写入队列，依次完成：更新内存 → 原子写 YAML → 往事件文件追加一行 → 登记待提交 → 通过 SSE 通知网页。
2. **同步文档**：Stop hook 在后台执行 `kh sync`，按第 9 节的三步协议增量推送。
3. **会话开始时先更新文档、再注入进度**：SessionStart hook 执行 `kh hook session-start`，先从其他机器拉取安全的文档更新（9.3），再输出精简的进度摘要和未解决的冲突，进入 AI 上下文。
4. **结束前提醒上报**：Stop hook 发现“有改动但没上报”时，以退出码 2 提醒 AI 一次。

## 5. 数据模型

所有实体在 `packages/core` 中用 zod 定义，服务端、`kh`、网页共用同一份定义。

### 5.1 标识与通用字段

- 实体 ID 是 10 位小写字母数字随机串，例如 `k3v9x2m7qa`。
- 任务在命令行输出和 AI 上下文里显示为 `#` 加最短的唯一前缀，至少 4 位，例如 `#k3v9`。
- 用户、机器、项目、容器、任务都有 `version`（整数，每次修改加 1）、`createdAt`、`updatedAt`。时间一律用带时区的 ISO 8601 字符串。

### 5.2 实体

**用户**

| 字段 | 说明 |
|---|---|
| `name` | 显示名 |
| `role` | `admin` / `member`。第一版只有一个 `admin` |
| `passwordHash` | scrypt 哈希 |
| `sessionVersion` | 改密码时加 1，所有会话随之失效 |

**机器**

| 字段 | 说明 |
|---|---|
| `name` | 别名，默认取主机名 |
| `userId` | 所属用户 |
| `os` | `darwin` / `linux` / `windows` |
| `tokenHash` | 令牌的 SHA-256 |
| `lastSeenAt` | 最后一次请求时间，最多每分钟更新一次 |
| `revokedAt` | 吊销时间；有值时令牌失效 |

**项目**

| 字段 | 说明 |
|---|---|
| `name`、`description` | 名称、一句话简介 |
| `cycle` | 周期，见 5.3 |
| `health` | 健康度，见 5.3 |
| `focus` | 当前焦点，一句话 |
| `fingerprint` | 仓库第一个提交的 hash；没有提交的仓库为空 |
| `locations[]` | 每项：`machineId`、`path`、`lastSyncAt`、`sync`（该位置上报的同步范围）、`git`（`branch`、`head`、`headSubject`、`headAt`、`dirtyCount`、`ahead`、`behind`）、`skippedFiles`（上次同步因超过大小上限而跳过的文件） |

**容器**

| 字段 | 说明 |
|---|---|
| `kind` | `phase`（阶段）/ `feature`（特性）/ `misc`（杂项）。每个项目自动建一个杂项容器，不能删除 |
| `code` | 编号，比如 `P0`、`M3a`，可以为空 |
| `title` | 标题 |
| `order` | 排序 |
| `targetVersion` | 目标版本，比如 `v1.1`，可以为空 |
| `targetDate` | 目标日期，可以为空 |
| `manualStatus` | `backlog`（储备）/ `suspended`（挂起）/ `cancelled`（已取消），可以为空 |
| `manualReason` | `manualStatus` 为挂起时必填 |

**任务**

| 字段 | 说明 |
|---|---|
| `containerId`、`code`、`title`、`order` | 所属容器、编号（可以为空）、标题、排序 |
| `status` | 见 5.3 |
| `suspendReason` | 状态为挂起时必填 |
| `human` | 待你处理：`{ kind: decision / verify / action, note }`，可以为空 |
| `group` | 分组标签，比如特性内部的 `M2` |
| `assigneeUserId` | 负责人，可以为空 |
| `note` | 一句话备注 |
| `docRefs[]` | 关联文档，保存仓库内的相对路径 |
| `checklist[]` | 清单项：`{ text, done }` |
| `dueDate` | 截止日期，可以为空 |
| `startedAt`、`completedAt` | 由状态变化自动记录，见 5.4 |

**事件**

| 字段 | 说明 |
|---|---|
| `id` | 事件 ID；时间线翻页时与 `ts` 一起作为游标 |
| `ts` | 事件时间 |
| `projectId` | 所属项目 |
| `actor` | `{ userId, machineId, via: web / cli, agent }`。`agent` 由 `kh` 从环境变量识别（比如 Claude Code 设置的 `CLAUDECODE=1`），也可以用 `--agent <名称>` 显式指定；识别不出来时为空 |
| `type` | `project.created` / `project.updated` / `container.created` / `container.updated` / `task.created` / `task.updated` / `task.status_changed` / `task.human_changed` / `log` / `docs.synced` / `docs.pulled` / `import.applied` |
| `target` | `{ containerId, taskId }`，按类型选填 |
| `change` | 变化的字段：`{ 字段名: { from, to } }` |
| `text` | 日志正文或备注 |
| `imported` | 是否来自导入的历史数据 |

### 5.3 枚举

| 枚举 | 取值（界面文案） |
|---|---|
| 周期 | `design` 设计期 / `development` 开发期 / `iteration` 迭代期 / `maintenance` 维护期 / `archived` 归档 |
| 健康度 | `on_track` 正常 / `at_risk` 有风险 / `blocked` 卡住 |
| 任务状态 | `todo` 待开始 ⬜ / `in_progress` 进行中 🔶 / `review` 复核中 👀 / `done` 已完成 ✅ / `suspended` 挂起 ⏸ / `cancelled` 已取消 |
| 待你处理 | `decision` 待决策 / `verify` 待验证 / `action` 待操作 |

### 5.4 推算规则

**任务日期**

- 第一次进入 `in_progress` 时记录 `startedAt`，以后重新打开也不覆盖。
- 进入 `done` 时记录 `completedAt`；从 `done` 改回其他状态时清空它。
- 任何状态之间都可以直接切换，AI 纠正错误时不受限制。

**容器状态**，按顺序判断，命中即停：

1. 有 `manualStatus`，就用它。
2. 排除 `cancelled` 后，没有任务或者剩下的全部是 `todo`，为“待开始”。
3. 排除 `cancelled` 后，剩下的全部是 `done`（至少一个），为“已完成”。
4. 其余情况为“进行中”。

杂项容器不参与推算，只显示未完成任务的数量。

**容器日期**：开始日期是任务 `startedAt` 的最小值；容器为“已完成”时，完成日期是任务 `completedAt` 的最大值。

**进度**：已完成数 ÷（总数 − 已取消数）。任务自己的清单单独计算完成度。项目整体进度只统计阶段和特性容器里的任务，不含杂项容器；容器自身的进度（上一段）仍然按各自容器内的任务计算，杂项容器不参与推算。

### 5.5 停滞

项目最近一条事件距今超过 `KH_STALE_DAYS` 天（默认 7 天），且周期不是“归档”，就标为停滞。

## 6. 服务端存储

第一版不引入任何数据库。所有读写都经过 `apps/web/src/server/` 下的存储模块，API 和页面不直接读写文件。以后要换成数据库，只需重写这一个模块。

### 6.1 数据目录

```
/data                              ← git 仓库
├── .gitignore                     # 排除 auth/ 和 .staging/
├── auth/
│   ├── users.yaml
│   ├── machines.yaml
│   └── session-secret             # 会话 cookie 的签名密钥，首次启动时生成
├── .staging/                      # 同步过程中暂存的文件内容与待应用的文件清单
└── projects/<项目ID>/
    ├── project.yaml
    ├── board.yaml                 # 全部容器与任务的当前状态
    ├── events/2026-09.jsonl       # 按月分文件，只追加
    ├── manifests/<机器ID>.json     # 该机器快照的清单：路径、sha256、大小、mtime、changedAt
    └── snapshots/<机器ID>/…        # 文档快照，保持仓库内的相对路径
```

凭据文件不进 git 历史，但会被打包进备份。

非 Docker 部署时，数据目录默认是 `~/.kanban-hub/server/data`，可以用 `--data-dir` 修改。

### 6.2 读取

启动时把所有 `project.yaml`、`board.yaml` 和最近 3 个月的事件读进内存，筛选和汇总都在内存里完成。更早的事件在时间线翻到时才从文件读取。

### 6.3 写入

- 所有写操作进入同一个异步队列，一个接一个执行。
- 写文件时先写临时文件，再重命名替换。
- 网页请求带上数据的 `version`，与当前版本不一致就返回 409。
- `kh` 的请求不带版本号，采用后写入者生效；冲突可以在事件时间线里查到。

### 6.4 git 提交

- 最后一次写入后 30 秒没有新的写入，就提交一次。备份前会立即提交一次。
- 同一批改动按操作者（用户 + 机器 + 来源）分组，一组一个提交。
- 提交的 author 是对应的用户（`<用户名> <用户ID@kanban-hub.local>`），committer 固定为 `kanban-hub`。
- 提交说明示例：`cli(mac): 3 项任务状态变更`。
- 调用系统的 `git` 命令，不用纯 JS 实现。

### 6.5 崩溃恢复

- 原子写入保证不会出现写了一半的文件。
- 启动时如果发现工作区有未提交的改动，先补一次提交。
- 启动时如果 `.staging/` 里有已经标记“待应用”的同步清单，就重新应用一遍。应用过程是幂等的，重复执行结果一样。

### 6.6 备份与恢复

- **触发**：网页 `/settings` 上的按钮，或者 `kh backup`。
- **格式**：ZIP，用 AES-256（WinZip AE-2）加密。密码为空时不加密。**密码不保存、不写日志**，忘记就无法解密。
- **内容**：`/data`（可以选择是否包含 `.git` 历史，默认包含）、`auth/`，以及一个 `manifest.json`（格式版本、创建时间、是否含历史）。
- **一致性**：打包期间暂停写入队列。
- **产物**：`/backups/kanban-hub-YYYYMMDD-HHmmss.zip`，网页上可以下载。失败时删除写了一半的文件。
- **恢复**：停止服务后执行 `docker compose run --rm kanban-hub restore /backups/<文件>`。只允许恢复到空的数据目录，否则拒绝执行。

## 7. 鉴权

| 对象 | 机制 |
|---|---|
| 管理员密码 | `KH_ADMIN_PASSWORD` 是唯一来源。启动时和保存的哈希比对，不一致就更新哈希，并让 `sessionVersion` 加 1，网页会话全部失效（机器令牌不受影响，只有吊销才会失效） |
| 网页会话 | 用 `session-secret` 签名的 cookie，内容包含 `userId` 和 `sessionVersion`，有效期 30 天，不续期。设置 `HttpOnly`、`SameSite=Strict`；写操作额外校验 `Origin` |
| 配对码 | 在网页上生成，6 位，形如 `K7Q-4MZ`，一次性使用，10 分钟有效，只保存在内存里 |
| 机器令牌 | 32 字节随机数，编码成 `kh_` 开头的 base64url 字符串。服务端只存 SHA-256，长期有效、不设过期时间，只有在网页上吊销才会失效 |
| 登录与配对限流 | `POST /api/v1/auth/login`、`POST /api/v1/pair` 共用同一个限流器：同一个 IP 对每个接口分别每分钟最多失败 5 次，另外有全局每分钟最多失败 30 次的上限，两个接口共用。客户端 IP 只能从 `X-Forwarded-For` 等请求头读取，这些头可以伪造，只按 IP 限流挡不住换着 IP 尝试 |
| `/raw` 文件 | 用能力 URL 访问：`/raw/<签名令牌>/<路径>`。令牌是对“项目、机器、过期时间”做的 HMAC，有效期 12 小时，由网页在渲染时签发。**不依赖 cookie**，因为在沙箱里运行的 demo 页面属于不透明来源，它加载的 css、js、图片等子资源拿不到 `SameSite=Strict` 的 cookie |

部署建议放在 HTTPS 反向代理之后。在局域网里直接用 HTTP 时，令牌和备份密码都以明文传输，这个风险由部署者自行评估。

## 8. 仓库接入

### 8.1 仓库内的 `.kanban-hub/config.yaml`

```yaml
projectId: k3v9x2m7qa
sync:
  include: [docs/**, CLAUDE.local.md]
  exclude: []            # 另外始终排除 **/node_modules/**、**/.git/**、**/.next/**
  maxFileSize: 5MB       # 服务端硬上限 20MB
pull:
  auto: true             # 会话开始时自动拉取其他机器的更新（9.3、12.3）
```

- 同步范围**不参考 `.gitignore`**，因为被忽略的私有文档目录恰恰需要同步。
- 这个目录默认写进 `.git/info/exclude`（worktree 场景下写到 `git rev-parse --git-common-dir` 所指目录下的 `info/exclude`），不改仓库的 `.gitignore`，也不会被提交。想入库时执行 `git add -f .kanban-hub`。

### 8.2 `kh register` 流程

1. 找到仓库根目录。不是 git 仓库也可以注册，只是没有指纹。
2. 如果 `.kanban-hub/config.yaml` 已经存在，就显示当前的注册信息；如果本机在这个项目上还没有登记位置，或者登记的路径不是当前仓库根，就按第 6 步的方式补登记本机位置（同样遵守 `--dry-run` / `--yes`），否则到此结束。
3. 计算指纹：`git rev-list --max-parents=0 HEAD` 的结果，有多个时取排序后的第一个。
4. 向服务端查询指纹相同的项目。找到了，就建议作为已有项目的另一个位置关联起来（`--bind <项目ID>`）；否则新建（`--new`）。
5. 扫描常见的文档位置（`docs/`、`doc/`、`design/`、根目录下的 `*.md`、`CLAUDE.local.md`），给出建议的同步范围。
6. 写入 `config.yaml` 和 `.git/info/exclude`，向服务端登记这个位置，然后做一次首次同步（文档同步见第 9 节）。

供 agent 使用的非交互写法：`kh register --name <名称> (--bind <ID> | --new) [--include <glob>…] --yes`。先用 `--dry-run` 只显示计划、不执行。

## 9. 文档同步

### 9.1 三步协议

1. `POST /api/v1/projects/:id/sync/manifest`：发送文件清单 `[{ path, sha256, size, mtime }]` 和 git 状态。服务端在 `.staging/<syncId>/` 下记录这份清单，返回缺少的 hash 列表和 `syncId`。
2. `PUT /api/v1/projects/:id/sync/blobs/:sha256`：逐个上传缺少的文件内容。服务端校验 hash 后暂存。
3. `POST /api/v1/projects/:id/sync/commit`：服务端先把清单标记为“待应用”，然后在写入队列里更新 `snapshots/<机器ID>/`：新增或替换变化的文件，删除清单里已经没有的文件；同时更新 `manifests/<机器ID>.json`，内容有变化的路径把 `changedAt` 记为当前时间；再更新位置信息，最后记一条 `docs.synced` 事件，并删除暂存。

- 第 3 步之前任何环节中断，旧快照都保持原样。
- 超过 24 小时没有完成的暂存会被清理。
- `kh` 在 `~/.kanban-hub/cache/` 里按路径缓存 `size + mtime → sha256`，避免每次都重新计算 hash。

### 9.2 规则

- 同一项目在不同机器上的快照分开存放，互不覆盖。网页默认显示最近同步的那一份，可以切换。
- 超过 `maxFileSize` 的文件不上传，记进位置的 `skippedFiles`。
- 路径统一成相对于仓库根目录的 POSIX 形式，拒绝 `..` 和绝对路径；`kh` 不跟随指向仓库外的软链接。服务端写入前再校验一次，保证目标路径落在快照目录内。
- 服务端不会主动把文件推给任何机器。文档从服务端回到机器上，只能由该机器的 `kh` 主动拉取（9.3）。

### 9.3 跨机器读取、拉取与冲突处理

进了 git 的文件靠 `git pull` 在机器间流转。**拉取一律跳过被 git 跟踪的文件**（以本机 `git ls-files` 的结果为准），避免把其他机器上尚未提交的改动写进本机的工作区。下面的机制只处理没进 git 的文档，比如 `docs/_internal/`、`CLAUDE.local.md`。拉取范围是本机 `sync.include` 与对方快照的交集。

**命令**

| 命令 | 作用 |
|---|---|
| `kh docs ls [--from <机器>] [<glob>]` | 列出其他机器快照里的文件：路径、大小、更新时间 |
| `kh docs cat [--from <机器>] <路径>` | 把一份文档打印到标准输出，**不写本地磁盘** |
| `kh pull [--from <机器>] [--path <glob>] [--dry-run]` | 按下面的规则把其他机器的版本拉到本地 |
| `kh conflicts` | 列出未解决的冲突 |
| `kh conflicts show <路径>` | 输出冲突的差异，不改本地文件。文本文件用 `git merge-file -p --diff3` 输出带 `<<<<<<<` / `\|\|\|\|\|\|\|` / `=======` / `>>>>>>>` 标记的合并结果，分别标明本机、共同基准、对方机器；二进制文件或没有基准内容时，改用 `git diff --no-index` 输出双方差异 |
| `kh conflicts resolve <路径> (--edited \| --take-local \| --take-remote)` | 标记冲突已解决。`--edited`：本地文件已经改成最终内容；`--take-remote`：用对方版本覆盖本地；`--take-local`：保留本地。解决后把基准更新为对方的版本，下一次 `kh sync` 推送的就是最终内容 |

**选哪个版本作为“对方”**：服务端为每台机器的快照维护一份清单（`manifests/<机器ID>.json`），记录每个路径的 sha256 和 `changedAt`，即服务端第一次收到这份内容的时间。`--from` 省略时，每个路径分别取其他机器里 `changedAt` 最新的那一份；指定了 `--from` 就只看那台机器。

**基准**：`kh` 在本机为每个路径记录一个“基准”，即本机最近一次推送成功、拉取写入或解决冲突时的内容。基准的 hash 记在缓存里，内容另存一份到 `~/.kanban-hub/cache/<项目ID>/blobs/`，供三方合并使用；不再被引用的内容会自动清理。

**逐文件处理规则**

| 情况 | 处理 |
|---|---|
| 本地和对方内容相同 | 不动，只更新基准 |
| 本地不存在，且没有基准 | 用对方的版本新建 |
| 本地没改过（等于基准），对方改了 | 用对方的版本覆盖 |
| 本地改过，对方没改（等于基准） | 保留本地 |
| 两边都改了，都是文本，且有基准内容 | 用 `git merge-file` 做三方合并：改动没有重叠就**自动合并**，写入本地，结果里列为“自动合并”；有重叠就登记为**冲突**，本地文件不动 |
| 两边都改了，但是二进制文件，或者没有基准内容 | 登记为冲突，本地文件不动 |
| 对方已经删除这个文件 | 不动。**拉取从不删除本地文件** |
| 这个路径已有未解决的冲突 | 跳过，保持冲突状态 |

- 登记冲突时，对方版本的内容会存进本机缓存，之后处理冲突不需要联网。
- `--dry-run` 只列出将要新建、覆盖、自动合并和冲突的文件，不写任何东西。
- 每次拉取都会记一条 `docs.pulled` 事件，内容包括新建、覆盖、自动合并、冲突各多少个。
- 冲突没解决之前，这个文件照常推送本机的版本，服务端上对方的版本也保持不变，双方互不覆盖。

**自动拉取**：`.kanban-hub/config.yaml` 里的 `pull.auto` 默认为 `true`。开启时，SessionStart hook 在会话开始时自动执行一次拉取（见 12.3），先把文档更新到最新，尽量减少之后的冲突。

## 10. 命令行 `kh`

### 10.1 安装与本机文件

- 要求 Node 22 及以上和 git（拉取时的三方合并用 `git merge-file`）。服务端在 `/setup/kh.tgz` 提供与自身版本一致的安装包，用 `npm i -g <服务端地址>/setup/kh.tgz` 安装。第一版不发布到 npm。
- 本机目录默认 `~/.kanban-hub/`，可以用环境变量 `KH_HOME` 指定（必须是绝对路径）。

```
~/.kanban-hub/
├── config.yaml      # 服务端地址、本机 machineId 与名称
├── credentials      # 本机令牌，文件权限 600
├── cache/           # 文件 hash 缓存；每个项目的基准 hash、基准内容与未解决的冲突（9.3）；会话标记；各项目最近一次上报时间
├── imports/         # AI 生成的导入文件
└── logs/            # hook.log（限制大小，自动轮转）
```

### 10.2 命令

| 分组 | 命令 |
|---|---|
| 接入 | `kh login --server <URL> --code <配对码> [--name <机器名>]`、`kh logout`、`kh whoami` |
| | `kh setup [--dry-run] [--yes] [--uninstall]`：安装或卸载 skill 与 hook，见 12.1 |
| 项目 | `kh register …`（见 8.2）、`kh status [--json]` |
| | `kh project set [--cycle <周期>] [--health <健康度>] [--focus "…"]` |
| 容器 | `kh container add <phase\|feature> "<标题>" [--code <编号>] [--version <版本>] [--target-date <日期>]` |
| | `kh container set <容器> [--status backlog\|suspended\|cancelled\|auto] [--reason "…"] …` |
| 任务 | `kh task add <容器> "<标题>" [--code <编号>] [--group <标签>] [--doc <路径>]… [--due <日期>]` |
| | `kh task set <任务> [--status <状态>] [--reason "…"] [--note "…"] [--doc <路径>]… [--title "…"] [--code <编号>] [--group <标签>] [--due <日期>] [--container <容器>]` |
| | `kh task human <任务> (--decision\|--verify\|--action) "<说明>"`、`kh task human <任务> --clear` |
| | `kh task check <任务> <清单项序号> [--undo]`、`kh task checklist <任务> --add "…"` |
| 时间线 | `kh log "<正文>"` |
| 同步 | `kh sync [--quiet]`（推送） |
| 跨机器文档 | `kh docs ls`、`kh docs cat`、`kh pull`、`kh conflicts [show \| resolve]`，见 9.3 |
| 迁移 | `kh import <文件> [--dry-run]`、`kh export [--md] [-o <文件>]` |
| 管理 | `kh backup [--no-history]`：交互式输入密码 |
| 内部 | `kh hook session-start`、`kh hook stop` |

- **指定容器**：用编号（`M2`）或 ID 前缀；杂项容器写 `misc`。
- **指定任务**：用 `容器编号/任务编号`（`M2/2.3`），或者 `kh status` 里显示的 `#` 短 ID。
- `kh task set --container <容器>` 把任务移到另一个容器（写法同上）。
- 可空字段传空串表示清空，例如 `--code ""`、`--group ""`、`--due ""`、`--version ""`。
- 所有命令都支持 `--agent <名称>`，用来显式标明调用者是哪个 agent。

### 10.3 退出码

| 退出码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 其他意外错误（例如服务端内部错误或响应格式不符） |
| 2 | 用法错误 |
| 3 | 未登录或令牌失效，提示去 `/setup` 重新接入 |
| 4 | 服务端连不上 |
| 5 | 数据校验失败或版本冲突 |
| 6 | 版本不兼容（服务端返回 426），提示重新安装 |

细分归属：429（请求过于频繁）和配对码无效属于 3；503、以及网关返回的非 JSON 响应（例如 502、504）属于 4；不带错误信封的 404/405（服务端根本没有这个接口，多半是版本不一致）属于 6；带错误信封的 404，以及 400、409、413，属于 5。

### 10.4 导入导出格式

YAML，顶层写 `format: kanban-hub/v1`，包含 `project`（周期、健康度、焦点）、`containers[]`（每个容器里嵌套 `tasks[]`，任务可以带历史日期）和可选的 `events[]`（历史日志）。导入和导出用同一种格式。

重复导入时的匹配规则：

- 容器先按 `kind + code` 匹配，编号为空时按标题匹配；任务在所属容器内先按 `code` 匹配，编号为空时按标题匹配。
- 匹配上的更新，匹配不上的新建；导入文件里没有的现有条目保持不动。
- 历史事件标记为 `imported`，按“时间 + 正文 hash”去重。
- `--dry-run` 列出将要新建、更新的条目和状态变化，不写入任何数据。

`kh export --md` 把看板渲染成 Markdown 快照，适合想把进度放进仓库的项目。

## 11. API

统一前缀 `/api/v1`，请求和响应都用 JSON，并用 `packages/core` 里的 zod schema 校验。`kh` 每次请求都带 `X-KH-Version` 头，服务端判断不兼容时返回 426；`/api/v1` 接口的响应都带 `X-KH-Version`，标明服务端版本。令牌请求可以另外带 `X-KH-Agent`（1-50 个可打印 ASCII 字符，不含空格）标识自己，会写进对应事件的操作者；缺失或去掉首尾空白后为空当作没有，格式不对时返回 400。

| 用途 | 接口 |
|---|---|
| 健康检查 | `GET /api/health`（无需鉴权） |
| 配对 | `POST /pair`：`{ code, machineName, os }` → `{ token, machineId }` |
| 会话 | `POST /auth/login`、`POST /auth/logout`、`GET /me`（当前用户与服务端版本；令牌鉴权时还带上本机信息） |
| 机器 | `GET /machines`、`POST /machines/:id/revoke`、`POST /pairing-codes` |
| 项目 | `GET /projects`、`GET /projects?fingerprint=…`、`POST /projects`、`GET /projects/:id`、`PATCH /projects/:id`、`PUT /projects/:id/locations/:machineId` |
| 容器 | `POST /projects/:id/containers`、`PATCH /projects/:id/containers/:cid` |
| 任务 | `POST /projects/:id/tasks`、`PATCH /projects/:id/tasks/:tid` |
| 时间线 | `POST /projects/:id/log`、`GET /events?project=&before=&limit=` |
| 同步 | 见 9.1 |
| 文档 | `GET /projects/:id/docs?machine=`（文件树与最近更新）、`POST /projects/:id/raw-tokens` |
| 快照读取（供 `kh`） | `GET /projects/:id/snapshots/:machineId/manifest`（路径、sha256、大小、changedAt）、`GET /projects/:id/snapshots/latest-manifest?exclude=<本机ID>`（每个路径取其他机器中最新的一份）、`GET /projects/:id/snapshots/:machineId/files/*path`（文件内容，响应头带 sha256） |
| 导入导出 | `POST /projects/:id/import?dryRun=1`、`GET /projects/:id/export?format=yaml\|md` |
| 实时推送 | `GET /stream`（SSE，只接受网页会话） |
| 备份 | `POST /backups`、`GET /backups`、`GET /backups/:name` |

接入引导文件公开访问，不需要鉴权，也不包含任何凭据：`/setup/agent.md`、`/setup/migrate.md`、`/setup/kh.tgz`。

## 12. AI 接入

### 12.1 `kh setup`

1. **写入通用 skill**：放到 `~/.agents/skills/kanban-hub/SKILL.md`，Codex、Gemini CLI、Cursor 等都会读这个目录。
2. **检测到 `~/.claude/` 时**：
   - 往 `~/.claude/skills/kanban-hub/` 复制一份 skill。用复制而不用软链接，不依赖各家对软链接的支持。
   - 往 `~/.claude/settings.json` 合并两个 hook：SessionStart → `kh hook session-start`，Stop → `kh hook stop`，超时都设为 15 秒。合并时保留已有配置，修改前先备份成 `settings.json.bak-<时间戳>`。
3. `--dry-run` 只列出将要做的改动；`--yes` 直接执行。agent 应该先执行 `--dry-run` 给用户看，得到确认后再加 `--yes`。
4. 重复执行会覆盖更新 skill，但不会重复添加 hook。

### 12.2 skill 内容要点

skill 里只写 `kh` 命令和规则，不引用任何一家 agent 特有的工具名。frontmatter 只用标准要求的 `name` 和 `description`。

- **什么时候生效**：仓库根目录有 `.kanban-hub/`，或者用户提到进度、看板时。
- **上报规则**：
  - 开始做某个任务，标为 `in_progress`；做完进入审查，标为 `review`；**验证通过后才能标 `done`**。
  - 卡住了标为 `suspended` 并写明原因；需要用户拍板或动手的，用 `kh task human` 打上标记。
  - 干活时发现的新问题，用 `kh task add misc …` 记下来，不打断手头的任务。
  - 完成一批工作后，用 `kh log` 写一条时间线日志。
  - 项目周期、健康度、当前焦点有变化时，用 `kh project set` 更新。
- **跨机器文档**：需要参考另一台机器上没进 git 的文档时，用 `kh docs ls` 和 `kh docs cat` 读取。
- **冲突处理**：会话开始时的进度摘要会列出未解决的冲突。**有冲突时先处理冲突，再开始任务**：
  1. 对每个冲突执行 `kh conflicts show <路径>`，查看三方差异。
  2. 两边的改动互相兼容时（改的是不同段落、都是补充内容、一边只是调整格式），自己把本地文件编辑成合并后的内容，然后执行 `kh conflicts resolve <路径> --edited`。
  3. 两边对同一处内容的改法互相矛盾（比如同一个决定、数值、状态写得不一样），或者拿不准以哪边为准时，**把差异展示给用户，问清楚再改**。
  4. 不能为了省事直接整份采用某一边，除非另一边的改动确实已经包含在里面，或者用户同意这样做。
  5. 全部解决后执行 `kh sync`。
- **没有 hook 时的兜底规则**：开工前先执行 `kh pull` 和 `kh status`，有冲突按上面的流程处理；写完文档执行 `kh sync`；结束前检查有没有该上报的进度。
- **注册流程**：见 8.2。
- **导入流程**：读取仓库里已有的进度文档（比如 `TASKS.md`）→ 写成 `~/.kanban-hub/imports/<项目>.yaml` → 执行 `kh import --dry-run` 给用户看 → 用户确认后正式导入。导入后不修改原来的进度文档，只提醒用户它以后改作开发笔记使用。

### 12.3 hook（Claude Code）

两个 hook 都先检查当前仓库根目录有没有 `.kanban-hub/`，没有就立即退出，不产生任何输出。

**`kh hook session-start`**
1. 从标准输入读取 `session_id`、`cwd`。
2. **自动拉取**（`pull.auto` 为 `true` 时）：按 9.3 的规则只应用安全的更新，即新建、覆盖本地没改过的文件、没有重叠的自动合并；冲突只登记，不处理。限时 8 秒，到时间就停下，并在摘要里提示手动执行 `kh pull`。
3. 用 3 秒拉取项目状态，向标准输出打印进度摘要（不超过 40 行），内容包括：项目名、周期、健康度、当前焦点、进行中和复核中的任务（带 `#` 短 ID）、待你处理的事项、本次自动拉取的结果、**未解决的冲突列表**（有冲突时加一句“先处理冲突再开始任务”），以及 3 行以内的上报规则提示。
4. 在 `cache/sessions/<session_id>.json` 记下会话开始时间、`HEAD`、未提交改动的指纹。这一步放在自动拉取**之后**，所以拉下来的文件不算作本次会话的改动。
5. 任何失败都静默跳过，最终退出码为 0，只写日志。

**`kh hook stop`**
- 以脱离当前进程的方式在后台启动 `kh sync --quiet`，不等它完成。
- 同时满足以下全部条件时，向标准错误写一段提醒，以退出码 2 结束：
  1. 有这个会话的标记，且还没有提醒过；
  2. `stop_hook_active` 为假；
  3. `HEAD` 或未提交改动的指纹和会话开始时不同；
  4. 这台机器在这个项目上，自会话开始以来没有成功上报过（每次上报成功，`kh` 都会记录时间）。
- 提醒后把会话标记为“已提醒”。其他情况一律退出码 0。
- 超过 7 天的会话标记会被清理。

### 12.4 接入引导页 `/setup`

- **接入新机器**：网页生成配对码，同时给出一段可以直接复制的话，例如：“请按 `<KH_PUBLIC_URL>/setup/agent.md` 的说明把本机接入 kanban-hub，配对码 `K7Q-4MZ`。”`agent.md` 里写明步骤：检查 Node 版本 → 安装 `kh` → `kh login` → `kh setup --dry-run` 并请用户确认 → `kh setup --yes`。
- **迁移项目**：“请按 `<KH_PUBLIC_URL>/setup/migrate.md` 的说明把当前仓库接入 kanban-hub。”`migrate.md` 引导 agent 完成注册（8.2）和导入（12.2）。
- 页面上还有机器列表：显示名称、系统、最后在线时间，可以吊销。

## 13. 网页

| 页面 | 内容 |
|---|---|
| `/login` | 密码登录 |
| `/` 总览 | 顶部是跨项目的“待你处理”收件箱，按决策、验证、操作分组。下面是项目卡片：周期、健康度、当前焦点、进度条、最近活动、停滞标记，以及所在机器和 git 状态 |
| `/p/:id` 项目 | 四个标签页：**看板**（进行中的特性、阶段、储备、杂项；已完成的容器折叠成一行摘要。任务行显示状态、编号、标题、分组、待你处理、备注、文档链接、日期；点击后在侧边栏编辑，包括清单）、**时间线**、**文档**、**设置**（各位置信息、同步范围、跳过的文件、导出） |
| `/p/:id/docs/…` | 左边是文件树（可以切换机器，显示同步时间）和“最近更新”列表；右边渲染 Markdown：GFM、代码高亮、mermaid；文档里的相对链接改写成站内跳转，图片通过 `/raw` 加载；用 rehype-sanitize 清理 HTML |
| `/raw/<令牌>/…` | 原始文件，在新标签页打开。html 和 svg 带 `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups`；所有文件都带 `X-Content-Type-Options: nosniff`，按扩展名设置 `Content-Type` |
| `/timeline` | 跨项目的时间线，可以按项目、事件类型、操作者筛选 |
| `/setup` | 见 12.4 |
| `/settings` | 备份（输入密码、选择是否含历史）、备份列表与下载、服务信息（版本、数据目录、待提交改动数） |

- **实时刷新**：网页通过 SSE 接收改动，更新看板和收件箱；断线后自动重连，重连后重新拉取一次数据。
- **UI**：shadcn/ui + Tailwind CSS + lucide 图标；文案通过 next-intl 集中管理，第一版只有中文。

## 14. 部署

### 14.1 生产

`deploy/docker-compose.yml` 配合 `.env`：

| 变量 | 说明 |
|---|---|
| `PUID` / `PGID` | 容器的运行身份，填宿主机上的 `id -u` / `id -g`，默认 1000 |
| `UMASK` | 新建文件的权限掩码，默认 `022`；需要同组可写时用 `002` |
| `KH_ADMIN_PASSWORD` | 必填，管理员密码的唯一来源 |
| `KH_PORT` | 默认 `28970` |
| `KH_BIND` | 默认 `0.0.0.0`；放在反向代理之后时设为 `127.0.0.1` |
| `KH_PUBLIC_URL` | 写进接入引导那段话里的地址；不填时从请求的 Host 推断。同时是网页写操作校验同源时信任的来源：部署在会改写 Host 的反向代理后面时需要设置它（或者让代理保留原始 Host）；值不是合法的 http/https 地址时服务拒绝启动 |
| `KH_STALE_DAYS` | 停滞判定的天数，默认 7 |
| `TZ` | 时区 |

- 挂载 `./data:/data`、`./backups:/backups`。
- 镜像里自带 git，健康检查走 `/api/health`。
- 入口脚本支持两个子命令：`serve`（默认）和 `restore <文件>`。

### 14.2 文件属主与权限

- 运行阶段用 `USER node`，compose 里设置 `user: "${PUID}:${PGID}"`，不以 root 运行。
- 挂载目录必须提前在宿主机上建好（`mkdir -p data backups`）。否则 Docker 会以 root 身份自动创建它们。
- 启动时自检：`/data`、`/backups` 不可写就立即退出，并打印应该执行的 `chown` 命令。
- 入口脚本在启动 node 之前：执行 `umask $UMASK`；把 `HOME` 设成一个可写的目录；设置 `GIT_COMMITTER_NAME=kanban-hub`；镜像里预先配置 `safe.directory=/data`。原因是容器的 UID 在系统里可能没有对应的用户，git 会因为缺少 HOME 或提交者身份而出错。

### 14.3 开发

`docker-compose.dev.yml`：

- 挂载源码，运行 `pnpm dev`，改代码就能热更新。
- `node_modules` 和 `apps/web/.next` 放在命名卷里，构建产物不会写进源码目录。
- 热更新依赖挂载目录的原生文件事件（Docker Desktop 会转发宿主机的文件变化，Linux 宿主是 inotify）。不设 `WATCHPACK_POLLING`：它只对 webpack 生效，Next 16 的开发服务用 Turbopack。
- 同样设置 `user: "${PUID}:${PGID}"`。
- 数据目录挂载到 `./dev-data`（不入库）。

### 14.4 不用 Docker

也可以执行 `pnpm build` 后，用 node 直接运行 standalone 产物里的 `server.js`（monorepo 下它嵌套在 `.next/standalone/apps/web/` 里），配合 systemd 常驻，文档里给出 unit 示例。这种方式要求宿主机装有 Node 22 及以上和 git。

## 15. 错误处理

| 场景 | 处理方式 |
|---|---|
| hook 执行失败 | 绝不阻塞会话：不输出任何内容，退出码 0，只写 `hook.log` |
| AI 调用 `kh` 出错 | 输出明确的中文错误信息，并按 10.3 的退出码区分原因；第一版不做离线队列 |
| 同步中断 | 第 3 步之前中断，旧快照不变；暂存超过 24 小时自动清理 |
| 文件超过大小上限 | 跳过，并记进 `skippedFiles` |
| 拉取时两边都改过 | 改动没有重叠就自动合并；否则登记为冲突，本地文件不动，由 AI 按 skill 处理，拿不准时问用户；拉取从不删除本地文件 |
| 拉取时其他机器都没有快照 | 退出码 5，提示其他机器还没有同步过这个项目 |
| 会话开始时自动拉取超时 | 停止拉取，已写入的文件保留（每个文件的写入都是原子的），摘要里提示手动执行 `kh pull` |
| 请求数据不合法 | 400，附上出错的字段路径 |
| 版本冲突 | 409，网页提示“数据已被更新”并刷新 |
| git 提交失败 | 退避重试；数据文件不受影响；网页显示待提交的改动数量 |
| 启动自检失败 | 目录不可写、没有 git、YAML 解析失败（指出具体的文件和行号）、`KH_PUBLIC_URL` 不是合法的 http/https 地址，都拒绝启动 |
| 备份失败 | 删除写了一半的文件，返回错误原因 |

## 16. 测试

按 TDD 进行。Vitest 跑在 node 环境里；能测的判定逻辑下沉到 `packages/core` 和 `apps/web/src/lib` 的纯函数里。

| 层次 | 覆盖内容 |
|---|---|
| `packages/core` 单元测试 | schema 校验；容器状态、日期、进度的推算；导入差异比对；任务指定方式的解析；路径规范化；拉取的逐文件处理规则（9.3 表格里每种情况各一个用例）；按 `changedAt` 选择对方版本 |
| 存储层集成测试 | 临时目录加真实 git：原子写入、按操作者分组提交、启动时补提交、重放待应用的同步清单、备份能用密码解开且内容完整、只能恢复到空目录 |
| API 测试 | 直接调用 route handler：鉴权（令牌、会话、吊销、配对限流）、400、409、426、同步三步协议、拒绝路径穿越、`/raw` 令牌校验与响应头 |
| `kh` 测试 | 对接进程内启动的测试服务端：命令行为与退出码；`register` 的指纹匹配；`pull` 在临时仓库里的实际写入效果（新建、覆盖、`git merge-file` 自动合并、登记冲突、跳过被 git 跟踪的文件、从不删除本地文件、`--dry-run` 不写任何东西）；`conflicts show` 的输出和 `conflicts resolve` 之后的基准更新；会话开始时自动拉取超时后的提示；`setup` 合并 `settings.json` 时不破坏已有配置；hook 在没有 `.kanban-hub/` 或服务端连不上时静默、提醒只出现一次 |
| 页面组件 | eslint、`tsc --noEmit`、`next build`；不引入浏览器端测试框架 |
| Docker 部署 | 手工验收清单：构建、启动、健康检查、以 PUID 身份写出的文件属主、从备份恢复 |

## 17. 硬约束

- 开发阶段不建 CI 配置（`.github/workflows/`），到准备发布时再加。
- 第一版不引入数据库，存储细节封装在存储模块里。
- 不侵入被管理的仓库：`kh` 平时只在仓库里写 `.kanban-hub/` 和 `.git/info/exclude`，其余一律只读。唯一的例外是拉取（会话开始时自动执行，或者手动执行 `kh pull`）：只写同步范围内、没有被 git 跟踪的文件，而且从不删除本地文件。可以用 `pull.auto: false` 关闭自动拉取。
- 所有功能先写测试再写实现。
