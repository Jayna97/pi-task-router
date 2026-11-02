# pi-task-router

会话级选模型与分派策略，以及当前窗口内同步执行的 `subagent_inline`。

## 主要功能

- 读 `~/.pi/agent/task-router.json`：会话首条消息选模型（之后本会话固定），后续消息判断子任务 / 无关新任务并分流。
- 分派前确认；上下文过长提醒交接；任意模型请求失败且当前不是 fallback 时，提示切到 fallback。
- 角色只从 `~/.pi/agent/agents/*.md` 读取（支持软链接）。`session` 与 `dispatch: false` 不分派。
- 注册 `subagent_inline`：当前窗口另起 `pi` 子进程同步执行，不开新 herdr 窗口。
- 不在 herdr 中时：可分派角色全部改为窗口内执行；`session` 交接与 `/route handoff`、`/route new` 不可用。
- 命令：`/route [status|handoff|new|off|on|confirm on|confirm off]`。前缀 `@代号` 指定首条消息模型；`>>` 强制当作新窗口任务。

## 快速开始

### 前置依赖

| 依赖 | 必需 | 检查 | 缺失时 |
|---|---|---|---|
| [pi coding agent](https://github.com/badlogic/pi-mono) | 是 | `pi --version` | `curl -fsSL https://pi.dev/install.sh \| sh`，或 `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`（需 Node.js 22.19+） |
| [pi-herdr-subagents](https://github.com/0xRichardH/pi-herdr-subagents) | 开新窗口分派 `subagent` 时必需 | `pi list \| grep pi-herdr-subagents` | `pi install npm:pi-herdr-subagents` |
| herdr | 否。不在 herdr 中时全部走 `subagent_inline` | `command -v herdr` | 参见其官方文档 |

### 需要你提供的值

集中改这些占位符，不要散落替换：

| 占位符 | 含义 |
|---|---|
| `<owner>` | GitHub 用户或组织名 |
| `<REPO_URL>` | 本仓库 git 地址 |
| `<REPO_DIR>` | 本机克隆路径（绝对路径） |
| 各模型 `provider` / `id` | 写入 `task-router.json` 的 `models`，须在本机模型目录中存在且已配置凭据 |
| `analyzer.provider` / `analyzer.id` | 分析模型（`classifier` 或 `chat`） |

### 1. 安装本包

**自己的设备**（clone 到固定路径，按本地路径安装，之后可以直接改源码）：

```bash
git clone <REPO_URL> <REPO_DIR>
pi install <REPO_DIR>
pi list
```

`pi list` 应出现 `pi-task-router`，路径指向 `<REPO_DIR>`。

`pi install` 会把本地路径写成相对于 `~/.pi/agent/settings.json` 的相对路径。多台设备共用同一份 `settings.json` 时，必须把仓库克隆到相同的绝对路径。

**其他人**：

```bash
pi install git:github.com/<owner>/pi-task-router
pi list
```

不要同时把扩展放进 `~/.pi/agent/extensions/` 再 `pi install`，否则会重复加载、工具重复注册。

### 2. 链接或复制角色文件

本包的 `agents/*.md` **不会**随 `pi install` 自动生效。

```bash
mkdir -p ~/.pi/agent/agents
for f in coder verifier chore session; do
  ln -sfn "<REPO_DIR>/agents/${f}.md" ~/.pi/agent/agents/${f}.md
done
ls -l ~/.pi/agent/agents
```

应看到四个指向本仓库 `agents/` 的软链接。也可以 `cp <REPO_DIR>/agents/*.md ~/.pi/agent/agents/`。安装后按本机模型改各角色 frontmatter 的 `model`。

### 3. 复制并修改配置

```bash
cp <REPO_DIR>/task-router.example.json ~/.pi/agent/task-router.json
```

打开 `~/.pi/agent/task-router.json`，把示例里的模型代号、`provider`/`id`、`default`/`fallback`、`analyzer` 改成你目录里真实存在的值。不要把填好个人路径或密钥的配置提交回本仓库。

缺少配置、JSON 无效或校验失败时：**暂停自动路由**（不注入分派策略、不自动选模型/分流），并在 `session_start` 提示错误。

| 字段 | 含义 |
|---|---|
| `models` | 代号 → `{ provider, id, desc }`。代号须匹配 `[a-z][a-z0-9_-]*` |
| `default` / `fallback` | 默认模型、请求失败时的回退，必须是 `models` 中的代号。当前模型已是 fallback 时不再提示切换 |
| `analyzer` | `{ type: "classifier" \| "chat", provider, id, timeoutMs }` |
| `relationMinProb` | 分类器判断 relation 的最低置信度（0–1，缺省 0.6） |
| `contextWarn` | `{ tokens: number[], percent, userTurns }`，上下文过长提醒阈值 |
| `roles` | 可选。`{ "<角色名>": { use?, hint? } }`，覆盖分派策略里的用途说明 |
| `confirmTimeoutSec` | 分派确认框自动执行秒数；`0` 关闭 |
| `dispatch.inlineRoles` | 走 `subagent_inline` 的角色名 |
| `dispatch.inlineConfirmTimeoutSec` | 窗口内分派确认超时 |
| `features` | `autoModel` / `relationCheck` / `confirm` / `contextWarn` / `handoffAutoClose`，均为布尔 |
| `policyAppend` | 追加到分派规则末尾，不覆盖内置规则 |

analyzer 不可用时：先用配置的 analyzer；失败则改用当前会话模型再分析一次；当前模型也失败或就是 analyzer 本身则返回空结果（首条落到 `default`，后续分流拿不准时当 `continuation`）。

校验只读取已知字段；旧配置里多出来的键会被忽略，不会因此暂停路由。

### 4. 验证

```bash
pi --version
pi list | grep pi-task-router
command -v herdr   # 可选
```

启动 pi（不要加 `--no-extensions`），执行 `/route status`。正常时：

- `配置：` 后面是 `.../.pi/agent/task-router.json`，**不是**「已暂停（读取/校验失败）」
- `分析模型：` 为你配置的 `provider/id`（若不可用会注明改用当前模型）
- 列出已加载角色（`coder` / `verifier` / `chore` 等）

## 项目结构

```text
pi-task-router/
├── package.json                 # pi 包清单，声明两个扩展
├── task-router.example.json     # 配置示例，复制到 ~/.pi/agent/task-router.json
├── extensions/
│   ├── task-router.ts           # 选模型、分流、确认、handoff、失败切 fallback
│   └── inline-subagent/
│       ├── index.ts             # 注册 subagent_inline
│       └── agents.ts            # 从 ~/.pi/agent/agents 发现角色
└── agents/
    ├── coder.md                 # 编码执行者
    ├── verifier.md              # 验证者
    ├── chore.md                 # 杂务
    └── session.md               # 新窗口独立会话（不分派）
```

---

task-router 在 herdr 里做 `/route handoff` 前，会读 pi-herdr-subagents 挂在 `globalThis[Symbol.for("pi-subagents/runtime")].runningSubagents` 上的 `Map`，统计本进程自己派生的未完成子窗口。读不到时按 0 处理，不拦截交接。这不是公开 API，升级后可能失效。

个人项目，不做主要支持。
