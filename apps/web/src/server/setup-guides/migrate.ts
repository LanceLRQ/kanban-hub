import { COMMON_RULES, missingAddressNotice, serverAddress } from "./shared";

/** migrate.md 里的完整示例：必须能通过导入文件的 schema（测试里会取出第一个 yaml 代码块校验） */
const EXAMPLE_YAML = `format: kanban-hub/v1
project:
  cycle: development
  health: on_track
  focus: "完成第二阶段的接口联调"
containers:
  - kind: phase
    code: "P0"
    title: 工程骨架
    targetVersion: "0.1"
    targetDate: 2026-03-01
    tasks:
      - code: "0.1"
        title: 初始化仓库与工具链
        status: done
        startedAt: 2026-02-01T10:00:00+08:00
        completedAt: 2026-02-03T18:00:00+08:00
      - code: "0.2"
        title: 搭好持续集成
        status: done
        group: 工程
        note: "使用最小配置，后续再补缓存"
  - kind: phase
    code: "P1"
    title: 核心接口
    tasks:
      - code: "1.1"
        title: 用户接口
        status: in_progress
        docRefs: [docs/api.md]
        checklist:
          - { text: 登录, done: true }
          - { text: 注册, done: false }
      - code: "1.2"
        title: 权限模型
        status: todo
        human: { kind: decision, note: "需要确认是否支持多租户" }
        dueDate: 2026-04-15
  - kind: feature
    code: "F1"
    title: 导出报表
    manualStatus: suspended
    manualReason: "等待产品确认需求"
    tasks: []
  - kind: misc
    tasks:
      - title: 清理过期的临时脚本
        status: todo
events:
  - ts: 2026-02-03T18:00:00+08:00
    text: 完成工程骨架，仓库与工具链可用
`;

/**
 * 下发给 agent 读的“接入仓库并导入已有进度”说明。`publicUrl` 为 null 时用占位符，并要求 agent 先问用户。
 */
export function renderMigrateGuide(publicUrl: string | null): string {
  const server = serverAddress(publicUrl);
  return `# 把仓库接入 kanban-hub 并导入已有进度

${missingAddressNotice(publicUrl)}你正在帮用户把当前 git 仓库接入 kanban-hub（多项目进度看板），并把仓库里已有的进度文档导入进去。按下面的编号步骤依次执行。

${COMMON_RULES}
- 不要修改仓库里原有的进度文档。kh 只会在仓库里写 \`.kanban-hub/\`（默认写进 \`.git/info/exclude\`），其余一律只读。

## 1. 确认已登录

\`\`\`bash
kh whoami
\`\`\`

没有登录时，先按 \`${server}/setup/agent.md\` 的步骤把本机接入，再回来。

## 2. 注册仓库

在仓库根目录执行，先只看计划：

\`\`\`bash
kh register --dry-run
\`\`\`

计划里有项目名称、是新建项目还是绑定到已有项目、同步范围。**先问用户**这三项是否合适（名称想改、想绑定别的项目、同步范围要增减，都问清楚）。确认后用非交互写法执行：

\`\`\`bash
kh register --name "<项目名称>" --new --yes
# 绑定到已有项目时把 --new 换成 --bind <项目ID>
# 需要自定义同步范围时追加 --include "<glob>"，可以重复
\`\`\`

## 3. 看项目里现有的内容

\`\`\`bash
kh status
\`\`\`

记下项目里已有的容器（阶段、特性）和它们的编号。绑定到已有项目时尤其要对齐：导入文件里的编号要和这里一致，否则会新建重复的容器。

## 4. 把已有进度写成导入文件

在仓库里找已有的进度文档（例如 \`TASKS.md\`、\`docs/\` 下的计划、路线图），读懂后，按下面的格式写成 \`~/.kanban-hub/imports/<项目名>.yaml\`（目录不存在就先建）。

### 格式说明

文件是 YAML（按 YAML 1.2 解析，不要写 \`%YAML 1.1\` 指令），所有对象都不允许出现下面没有列出的字段。

**顶层**

| 字段 | 必填 | 含义 |
|---|---|---|
| \`format\` | 是 | 固定写 \`kanban-hub/v1\` |
| \`project\` | 否 | 项目字段，只有 \`cycle\`、\`health\`、\`focus\` 三个 |
| \`containers\` | 是 | 容器数组，可以是空数组；新建容器的顺序就是数组顺序 |
| \`events\` | 否 | 历史日志数组 |

**\`project\`**

- \`cycle\`：项目周期，可选值 \`design\`（设计期）、\`development\`（开发期）、\`iteration\`（迭代期）、\`maintenance\`（维护期）、\`archived\`（归档）。
- \`health\`：健康度，可选值 \`on_track\`（正常）、\`at_risk\`（有风险）、\`blocked\`（卡住）。
- \`focus\`：当前焦点，一句话，最长 200 字。

**\`containers[]\`**

| 字段 | 含义 |
|---|---|
| \`kind\` | 必填。\`phase\`（阶段）、\`feature\`（特性）、\`misc\`（杂项，整个文件最多一个） |
| \`code\` | 编号，例如 \`"P0"\`、\`"M2"\`，最长 20 字，不能含空白、\`/\`、\`#\`。可空 |
| \`title\` | 标题，杂项可以省略，其余在新建时必须有 |
| \`targetVersion\` | 目标版本，文本，例如 \`"1.0"\` |
| \`targetDate\` | 目标日期，\`YYYY-MM-DD\` |
| \`manualStatus\` | 手动状态：\`backlog\`（储备）、\`suspended\`（挂起）、\`cancelled\`（取消）；不写就由任务自动推算。杂项不能写 |
| \`manualReason\` | 手动状态是 \`suspended\` 时必填，说明原因 |
| \`tasks\` | 任务数组，顺序就是新建任务的顺序 |

**\`tasks[]\`**

| 字段 | 含义 |
|---|---|
| \`code\` | 编号，例如 \`"2.3"\`。可空 |
| \`title\` | 标题，新建时必填 |
| \`status\` | \`todo\`（待开始）、\`in_progress\`（进行中）、\`review\`（复核中）、\`done\`（已完成）、\`suspended\`（挂起）、\`cancelled\`（已取消） |
| \`suspendReason\` | 状态是 \`suspended\` 时必填 |
| \`human\` | “待你处理”：\`{ kind: decision \\| verify \\| action, note: "说明" }\`，分别表示需要用户决策、验证、操作 |
| \`group\` | 分组标签，最长 50 字 |
| \`note\` | 备注，最长 1000 字 |
| \`docRefs\` | 相关文档路径数组，仓库内的相对路径 |
| \`checklist\` | 清单，每项 \`{ text: "内容", done: true \\| false }\` |
| \`dueDate\` | 截止日期，\`YYYY-MM-DD\` |
| \`startedAt\` | 开始时间 |
| \`completedAt\` | 完成时间，只有 \`status: done\` 才能写 |

**\`events[]\`（历史日志）**：每项 \`{ ts, text }\`，\`ts\` 是发生时间，\`text\` 是正文。相同时间加相同正文的日志不会重复导入。

### 必须遵守的写法

- **文本字段一律加引号**：编号、标题、版本、分组、备注、说明、日志正文这类文本，只要看起来像数字或布尔值，就必须写成字符串。YAML 会把 \`2.3\` 解析成数字、把 \`1.10\` 解析成 \`1.1\`、把 \`targetVersion: 1.0\` 解析成 \`1\`，把 \`yes\`、\`true\` 解析成布尔值；kh 遇到这种情况会直接报错，不会自动转换。所以写 \`code: "1.10"\`，不要写 \`code: 1.10\`。
- **时间必须带时区**：\`startedAt\`、\`completedAt\`、\`events[].ts\` 写成 \`2026-02-03T18:00:00+08:00\` 或 \`2026-02-03T10:00:00Z\` 这种形式，不带时区会报错。日期（\`targetDate\`、\`dueDate\`）只写 \`YYYY-MM-DD\`。
- **历史日志的时间不能是未来**：不能晚于导入时刻 5 分钟以上。
- **不要写负责人**：用户 ID 不能跨服务端迁移，格式里没有这个字段。
- **只写有把握的内容**：原文档里没有的信息不要编造；不知道的字段直接省略。
- 需要清空某个可空字段时才写 \`null\`。

### 匹配规则（重复导入是安全的）

- 容器按“类型 + 编号”匹配（编号不分大小写）；文件里没写编号时，按“类型 + 标题”匹配；杂项直接对应项目的杂项容器。
- 文件里的编号在项目里找不到时，会再找一个**没有编号、类型相同、标题相同**的已有容器，匹配上后把编号写给它。
- 任务只在所属容器内匹配：先按编号（不分大小写），没写编号按标题，同样有“没有编号、标题相同”的兜底。任务换了容器，会在新容器里新建，旧的保持不动。
- 匹配上的条目，只更新文件里写了的字段；匹配不上的新建；文件里没有的现有条目保持不动。
- 同一份文件里，两个容器（或同一容器里的两个任务）的匹配依据相同会报错。

### 完整示例

\`\`\`yaml
${EXAMPLE_YAML}\`\`\`

示例里的日期都是过去的日期；你写的历史日期也要用真实发生过的时间，不要写未来。

## 5. 预览并导入

先预览，不写入任何数据：

\`\`\`bash
kh import ~/.kanban-hub/imports/<项目名>.yaml --dry-run
\`\`\`

把预览结果（将要新建、更新的条目和状态变化）给用户看。**先问用户**是否同意；有校验错误时，错误信息里带着字段路径（例如 \`containers[1].tasks[3].status\`），按提示改文件，再重新预览。得到确认后执行：

\`\`\`bash
kh import ~/.kanban-hub/imports/<项目名>.yaml
\`\`\`

## 6. 收尾

- 不要修改原来的进度文档，也不要删除它。提醒用户：进度以后以 kanban-hub 为准，原文档改作开发笔记。
- 再执行一次 \`kh status\` 确认结果，并把它告诉用户。
- 想把看板当前状态存成文件，可以用 \`kh export -o <文件>\`（加 \`--md\` 导出 Markdown）。

## 常见退出码

| 退出码 | 含义 | 处理 |
|---|---|---|
| 3 | 未登录或令牌失效 | 请用户到 \`${server}/setup\` 重新生成配对码，按 \`${server}/setup/agent.md\` 重新登录 |
| 4 | 服务端连不上 | 检查服务端地址和网络，把错误输出告诉用户 |
| 5 | 数据校验失败或版本冲突 | 导入文件有误时按提示修改；把错误原样告诉用户 |
| 6 | 版本不兼容 | 按 \`${server}/setup/agent.md\` 重新安装与服务端一致的版本 |
`;
}
