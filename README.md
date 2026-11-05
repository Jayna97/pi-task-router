# pi-task-router

[pi coding agent](https://github.com/earendil-works/pi) 扩展包：会话级选模型、子任务分派策略，以及在当前窗口内同步执行子代理的 `subagent_inline` 工具。

## 主要功能

- **会话选模型**：会话首条消息由分析模型判断任务难度，从配置的模型列表中选一个，之后本会话固定使用。消息前缀 `@代号` 可手动指定；启动时带 `--model` 或已用 `/model` 切换过的会话不自动选。
- **后续消息分流**：判断新消息是续聊、子任务还是无关新任务；后两者经确认后由当前 agent 写提示词并分派。消息前缀 `>>` 强制作为新窗口任务。
- **分派前确认**：拦截 `subagent` / `subagent_inline` 调用，可执行、查看或编辑任务、换模型、取消；超时自动执行（可关闭）。
- **`subagent_inline`**：在当前窗口另起 `pi` 子进程同步执行角色任务，结果直接作为工具返回值，不开新窗口。
- **角色**：从 `~/.pi/agent/agents/*.md` 读取。本包自带 `coder`（编码）、`verifier`（验证）、`chore`（杂务）、`session`（新窗口独立会话）。`session` 和 frontmatter 中 `dispatch: false` 的角色不参与分派。

## 命令

```text
/route [status|handoff [说明]|new <任务>|off|on|confirm on|confirm off]
```

`/route status` 显示当前配置、分析模型和各角色的执行方式；配置问题以及启动检查结果也会列在这里。

## 快速开始

### 依赖

- [pi](https://github.com/earendil-works/pi) ≥ 1.3.0，必需。
- [herdr](https://herdr.dev)，可选。开新窗口分派、`session` 角色和交接到新窗口都需要在 herdr 中运行 pi。
- [pi-herdr-subagents](https://github.com/0xRichardH/pi-herdr-subagents)，提供开新窗口分派的 `subagent` 工具；在 herdr 中开新窗口时需要：`pi install npm:pi-herdr-subagents`。Windows 上还需要 PATH 中有 bash，例如把 Git Bash 的 `bin` 目录加入 PATH。

不使用 herdr 时的行为见下文[不在 herdr 中运行时](#不在-herdr-中运行时)。

### 安装

```bash
pi install git:github.com/Jayna97/pi-task-router
```

安装时请检查 herdr 与 pi-herdr-subagents 是否已安装；缺失时告诉用户会失去哪些功能（见[不在 herdr 中运行时](#不在-herdr-中运行时)），并询问是否安装。

包会被克隆到 pi 配置目录下的 `git/github.com/Jayna97/pi-task-router`。pi 配置目录默认是 `~/.pi/agent`，设置了 `PI_CODING_AGENT_DIR` 时跟随该变量（配置文件、角色、handoff 均在此目录下）。下文的 `~/.pi/agent/...` 均指该目录。不要再把扩展文件另外放进 `~/.pi/agent/extensions/`，否则会重复注册工具。

### 用法一：直接用自带角色和示例配置

1. 把包里 `agents/` 下的四个角色文件**复制**到 `~/.pi/agent/agents/`（已有同名文件时自行合并）。不要用软链接：`pi update` 会重置克隆目录，`pi remove` 会删除克隆目录。
2. 把 `task-router.example.json` 复制为 `~/.pi/agent/task-router.json`。
3. 把模型换成你有凭据的模型：配置中的 `models`、`analyzer`，以及 `coder.md`、`verifier.md`、`chore.md` frontmatter 中的 `model`（`provider/id`）。`session.md` 没有写模型，不需要改。

### 用法二：用自己的角色

角色就是角色目录下的 `.md` 文件，可以增删或改写，自带的四个只是示例。角色目录是 pi 配置目录下的 `agents/`，默认 `~/.pi/agent/agents/`，设置了 `PI_CODING_AGENT_DIR` 时随之改变。

```markdown
---
name: reviewer
description: 代码审查。只读代码、指出问题，不改文件，完成后汇报。
model: openai/gpt-6.1-sol
thinking: high
tools: read, bash
---

你是代码审查者……（正文即该角色的系统提示词）
```

frontmatter 字段：

| 字段 | 作用 |
|---|---|
| `name` | 角色名。缺省时取文件名 |
| `description` | 角色用途，会写进分派策略；`subagent_inline` 同样要求填写 |
| `model` | 默认模型 `provider/id`；分派时可显式覆盖，缺省则继承调用方模型 |
| `thinking` | 默认思考等级，规则同 `model` |
| `tools` | 可用工具列表，`read, bash` 或 `[read, bash]` 均可；缺省不限制 |
| `spawning` | 是否允许该角色继续分派。缺省时只有 `session` 允许 |
| `dispatch` | `false` 表示不参与分派 |

`auto-exit`、`interactive`、`system-prompt` 等字段由 pi-herdr-subagents 读取，只对开新窗口执行生效。

正文是该角色的系统提示词，窗口内执行时追加在 pi 默认系统提示词之后。

`session` 是唯一特殊的名字：它始终开新窗口，不参与分派，不能用 `subagent_inline` 调用；在 session 窗口中 `subagent_done` 会被拦截，由用户决定何时结束；缺省允许继续分派。其他角色（除 `dispatch: false`）都参与分派。

`task-router.json` 中与角色相关的配置：

- `roles.<名>.use` 覆盖策略中的用途说明（缺省用 `description`），`hint` 追加一句提示。
- `dispatch.inlineRoles` 列出在 herdr 中也走窗口内执行的角色，其余可分派角色开新窗口。

配置引用了不存在的角色时，该项会被忽略并给出警告。

### 配置字段

配置文件为 `~/.pi/agent/task-router.json`，字段如下：

| 字段 | 含义 |
|---|---|
| `models` | 代号 → `{ provider, id, desc }`。`desc` 提供给分析模型作为选择依据 |
| `default` | 自动选模型失败时使用的代号 |
| `fallback` | 请求失败时提示切换到的代号 |
| `analyzer` | 分析模型，见下文 |
| `contextWarn` | `{ tokens: number[], percent, userTurns }`，任一达到即提醒交接 |
| `roles` | 可选，覆盖分派策略中各角色的用途说明 |
| `confirmTimeoutSec` | 新窗口分派确认的自动执行秒数，`0` 关闭 |
| `dispatch.inlineRoles` | 在 herdr 中也走 `subagent_inline` 的角色 |
| `dispatch.inlineConfirmTimeoutSec` | 窗口内分派确认的自动执行秒数，`0` 关闭 |
| `features` | `autoModel`、`relationCheck`、`confirm`、`contextWarn`、`handoffAutoClose` 开关，均为布尔值 |
| `policyAppend` | 可选，追加到分派规则末尾的文字 |

`analyzer` 负责判断首条消息用哪个模型、后续消息与当前任务的关系，有两种类型：

```json
"analyzer": { "type": "classifier", "provider": "typesafe", "id": "jev-latest", "timeoutMs": 15000 }
```

```json
"analyzer": { "type": "chat", "provider": "<provider>", "id": "<便宜的聊天模型>", "timeoutMs": 15000 }
```

`classifier` 调用 pi 的分类器模型（见 pi 文档 `docs/models.md` 的 “Use classifier models”），可配合 `relationMinProb`（缺省 0.6）设置分流的最低置信度；没有分类器时用 `chat`，选一个便宜的聊天模型即可。

配置完成后启动 `pi`，用 `/route status` 确认配置已加载。

## 不在 herdr 中运行时

是否在 herdr 中，以环境变量 `HERDR_ENV=1` 且存在 `HERDR_PANE_ID` 判断。不在 herdr 中时：

- **不可用**：开新窗口分派、`session` 角色、`handoff_open` 工具（不注册）、交接后自动关闭窗口。
- **改变行为**：所有可分派角色都用 `subagent_inline` 窗口内执行，`dispatch.inlineRoles` 不再起作用；`/route new` 和 `>>` 的新任务也在窗口内执行；`/route handoff` 只生成交接提示词，由你在新会话中使用。
- **不受影响**：选模型、分流、分派确认、请求失败切 fallback、上下文提醒。

在 herdr 中但没有安装 pi-herdr-subagents 时，`subagent` 工具不存在，开新窗口的角色和 `session` 都无法分派；`handoff_open` 和交接后自动关闭仍然可用。这种情况下把所有可分派角色写进 `dispatch.inlineRoles`。

## 更新与卸载

- 更新：`pi update git:github.com/Jayna97/pi-task-router`。只更新扩展代码，已复制的角色文件不会变，需要时自行对比合并。
- 卸载：`pi remove git:github.com/Jayna97/pi-task-router`，再删除 `~/.pi/agent/agents/` 中属于本包的角色文件（注意不要误删自己写的同名角色），以及可选的 `~/.pi/agent/task-router.json`。

## 项目结构

```text
pi-task-router/
├── package.json               # pi 包清单，声明两个扩展
├── task-router.example.json   # 配置示例
├── extensions/
│   ├── task-router.ts         # 选模型、分流、分派确认、交接、失败切 fallback
│   └── inline-subagent/
│       ├── index.ts           # subagent_inline 工具
│       └── agents.ts          # 角色发现
└── agents/                    # 角色文件，需复制到 ~/.pi/agent/agents/
    ├── coder.md               # 编码
    ├── verifier.md            # 验证
    ├── chore.md               # 杂务
    └── session.md             # 新窗口独立会话（不参与分派）
```

## 说明

- **启动检查**：每个会话提示一次。pi 低于 1.3.0 时提示升级；在 herdr 中但没有 `subagent` 工具时，提示安装 pi-herdr-subagents 或把可分派角色写入 `dispatch.inlineRoles`；Windows 上在 herdr 中但 PATH 里没有 bash 时，提示加入 Git Bash 的 `bin` 目录。不在 herdr 中时不做 herdr 相关提示。`/route status` 会显示这些检查结果。Windows 上 `handoff_open` 用 `pi.cmd` 启动，不走 herdr `agent start --kind pi`（后者会打到 npm 无扩展脚本）。推理模型若当前思考档是 `off`（从非推理模型切过来，或中继未声明 thinkingLevelMap），会抬到 `medium`。
- **请求失败切 fallback**：当前模型请求失败且不是 fallback 模型时，提示切换到 `fallback`。
- **上下文过长提醒**：超过 `contextWarn` 阈值时提示用 `/route handoff` 写交接说明并在新窗口接手，每项每会话只提醒一次。
- **配置无效时**：缺少配置文件、JSON 无效或校验失败时暂停自动路由（不选模型、不分流），启动时提示错误；分派确认仍生效，但不会超时自动执行。
- **analyzer 失败时**：先改用当前会话模型以 chat 方式再判断一次；仍失败则首条消息使用 `default`，后续消息按续聊处理。
- **统计未完成子窗口**：`/route handoff` 和上下文提醒前会读取 pi-herdr-subagents 的内部运行状态，统计本会话派生的未完成子窗口。这不是公开 API，读不到时按 0 处理，不拦截交接。
