# pi-task-router

[pi coding agent](https://github.com/earendil-works/pi) 扩展包：子任务分派策略，以及在当前窗口内同步执行子代理的 `subagent_inline` 工具。

## 主要功能

- **单窗口为主**：消息默认都在本会话处理，不对消息做自动判断或分流。只有用户主动使用命令/前缀（见[命令与前缀](#命令与前缀)），或在消息中明确要求开新窗口、子代理、交接时才分派。
- **行为规则外置**：何时分派等规则写在 markdown 文件里，随模型能力变化只改规则文件，不改代码。
- **分派前确认**：拦截 `subagent` / `subagent_inline` 调用，可执行、查看或编辑任务、换模型、取消；超时自动执行（可关闭）。
- **`subagent_inline`**：在当前窗口另起 `pi` 子进程同步执行角色任务，结果直接作为工具返回值，不开新窗口。
- **角色**：从 `~/.pi/agent/agents/*.md` 读取，格式与字段含义沿用 pi-herdr-subagents；task-router 不定义私有字段和特殊角色名。本包自带占位角色 `verifier`（验证）、`chore`（杂务）。

## 命令与前缀

### `/route` 命令

| 命令 | 作用 |
|---|---|
| `/route` 或 `/route status` | 显示当前模型、上下文用量、配置文件、分派确认开关、herdr 状态、各角色的执行方式（窗口内 / 新窗口）、功能开关、行为规则与子代理约定文件，以及配置警告和启动检查结果。无法识别的子命令也显示状态 |
| `/route handoff [说明]` | 把当前任务交接到新窗口：让当前 agent 写交接说明到 `~/.pi/agent/handoff/<名称>-<日期时间>.md`（目标、进度、关键决定、相关文件、未完成步骤、注意事项、「第一步」），再用 `handoff_open` 开普通会话接手，默认沿用当前模型和思考等级（`说明` 里指定了模型时按指定）。`说明` 会作为补充要求附上。还有未完成的子窗口时先询问等待还是强制交接；交接成功后询问是否关闭本窗口（`features.handoffAutoClose`）。不在 herdr 中时只输出交接提示词。`features.handoff=false` 时不可用 |
| `/route new [-c] <任务>` | 把一个与当前会话无关的新任务分派出去，不在本会话执行：herdr 中写任务说明并用 `handoff_open` 开普通会话；否则用 `subagent_inline` 窗口内执行。默认由 agent 按任务难度选模型；加 `-c`（或 `--current`）则使用当前模型和思考等级 |
| `/route confirm on` / `/route confirm off` | 本次运行中开 / 关分派前确认（初始值为 `features.confirm`）。`/route confirm` 不带参数等同 `on` |

### 消息前缀

| 前缀 | 作用 |
|---|---|
| `<< [说明]` | 与 `/route handoff [说明]` 相同，如 `<<` 或 `<< 新会话先跑测试` |
| `>> [-c] <任务>` | 与 `/route new [-c] <任务>` 相同，如 `>> -c 整理下载目录` |
| `@代号 <消息>` | 仅对会话首条消息有效：把本会话模型切换到配置 `models` 中的该代号（思考等级 `medium`），前缀会从消息中去掉。启动时带 `--model`、已用 `/model` 切换过的会话，以及子代理会话不处理该前缀 |

### 自然语言要求

在消息中明确说「开子代理」「派给某个角色」「让某个角色验一下」「交接」「开新窗口」等，由当前模型按行为规则调用对应工具：

| 工具 | 作用 |
|---|---|
| `subagent_inline` | 窗口内同步执行角色任务（单个或 `tasks` 并行），结果直接返回 |
| `subagent` | 开新 herdr 窗口执行角色任务（pi-herdr-subagents 提供），完成后结果回传 |
| `handoff_open` | 读取 `~/.pi/agent/handoff/` 下的说明文件，在新 tab 开普通 pi 会话，结果不回传（仅 herdr 中注册）。新 tab 放在当前 tab 之后（同一窗口多次交接按 handoff[1]、[2]… 依次排列；herdr 不支持 `tab.move` 时留在末尾）。`model`、`thinking` 可省略，省略时沿用当前会话的模型和思考等级 |

`subagent` / `subagent_inline` 调用前会弹出确认（`features.confirm`）：执行、查看或编辑任务、换模型（并行时为全部使用同一模型）、取消；超时按 `confirmTimeoutSec` / `dispatch.inlineConfirmTimeoutSec` 自动执行（编辑或换模型后不再自动执行），Esc 取消。

## 快速开始

### 依赖

- [pi](https://github.com/earendil-works/pi) ≥ 1.3.0，必需。
- [herdr](https://herdr.dev)，可选。开新窗口分派、交接和无关新任务开新窗口都需要在 herdr 中运行 pi。
- [pi-herdr-subagents](https://github.com/0xRichardH/pi-herdr-subagents)，提供开新窗口分派的 `subagent` 工具；在 herdr 中开新窗口时需要：`pi install npm:pi-herdr-subagents`。Windows 上还需要 PATH 中有 bash，例如把 Git Bash 的 `bin` 目录加入 PATH。

不使用 herdr 时的行为见下文[不在 herdr 中运行时](#不在-herdr-中运行时)。

### 安装

```bash
pi install git:github.com/Jayna97/pi-task-router
```

安装时请检查 herdr 与 pi-herdr-subagents 是否已安装；缺失时告诉用户会失去哪些功能（见[不在 herdr 中运行时](#不在-herdr-中运行时)），并询问是否安装。

包会被克隆到 pi 配置目录下的 `git/github.com/Jayna97/pi-task-router`。pi 配置目录默认是 `~/.pi/agent`，设置了 `PI_CODING_AGENT_DIR` 时跟随该变量（配置文件、角色、handoff 均在此目录下）。下文的 `~/.pi/agent/...` 均指该目录。不要再把扩展文件另外放进 `~/.pi/agent/extensions/`，否则会重复注册工具。

### 用法一：直接用自带角色和示例配置

1. 把包里 `agents/` 下的两个角色文件**复制**到 `~/.pi/agent/agents/`（已有同名文件时自行合并）。不要用软链接：`pi update` 会重置克隆目录，`pi remove` 会删除克隆目录。
2. 把 `task-router.example.json` 复制为 `~/.pi/agent/task-router.json`。
3. 把模型换成你有凭据的模型：配置中的 `models`，以及 `verifier.md`、`chore.md` frontmatter 中的 `model`（`provider/id`）。

### 用法二：用自己的角色

角色就是角色目录下的 `.md` 文件，可以增删或改写，自带的两个只是示例。子代理的通用约定（只依据任务提示词、有歧义时如何询问、资源安全、汇报格式）由 task-router 统一注入（见[子代理约定](#子代理约定)），角色正文只需写该角色特有的内容。角色目录是 pi 配置目录下的 `agents/`，默认 `~/.pi/agent/agents/`，设置了 `PI_CODING_AGENT_DIR` 时随之改变。

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

frontmatter 字段（均为 pi-herdr-subagents 的字段，含义一致；下表是 task-router 和 `subagent_inline` 会读的部分）：

| 字段 | 作用 |
|---|---|
| `name` | 角色名。缺省时取文件名 |
| `description` | 角色用途，会写进分派策略；`subagent_inline` 同样要求填写 |
| `model` | 默认模型 `provider/id`；分派时可显式覆盖，缺省则继承调用方模型 |
| `thinking` | 默认思考等级，规则同 `model` |
| `tools` | 可用工具列表，`read, bash` 或 `[read, bash]` 均可；缺省不限制 |
| `spawning` | `false` 表示该角色作为子代理时不能继续分派；缺省允许 |
| `disable-model-invocation` | `true` 表示不列入分派策略（仍可按名字显式调用） |

`auto-exit`、`interactive`、`system-prompt`、`skills` 等字段由 pi-herdr-subagents 读取，只对开新窗口执行生效。

正文是该角色的系统提示词，窗口内执行时追加在 pi 默认系统提示词之后。正文可以为空。

角色说明只以角色文件为准。`task-router.json` 中与角色相关的配置只有：

- `dispatch.inlineRoles` 列出在 herdr 中也走窗口内执行的角色，其余可分派角色开新窗口。

配置引用了不存在的角色时，该项会被忽略并给出警告。

### 配置字段

配置文件为 `~/.pi/agent/task-router.json`，字段如下：

| 字段 | 含义 |
|---|---|
| `models` | 代号 → `{ provider, id, desc }`。`desc` 写进分派策略的模型表，供分派时选模型 |
| `fallback` | 请求失败时提示切换到的代号 |
| `contextWarn` | `{ tokens: number[], percent, userTurns }`，任一达到即提醒交接 |
| `confirmTimeoutSec` | 新窗口分派确认的自动执行秒数，`0` 关闭 |
| `dispatch.inlineRoles` | 在 herdr 中也走 `subagent_inline` 的角色 |
| `dispatch.inlineConfirmTimeoutSec` | 窗口内分派确认的自动执行秒数，`0` 关闭 |
| `features` | 功能开关，均为可选布尔值，缺省 `true`。见下文 |
| `policyFile` | 可选，行为规则 markdown 路径（支持 `~`），缺省 `<pi 配置目录>/task-router.policy.md` |
| `policyAppend` | 可选，追加到分派规则末尾的文字 |

配置完成后启动 `pi`，用 `/route status` 确认配置已加载。

### features

写在 `features` 对象下，全部可选，缺省 `true`。旧配置不写新键时仍正常加载，不会因此暂停路由。

| 键 | 作用 |
|---|---|
| `confirm` | 分派前确认 |
| `contextWarn` | 上下文过长提醒 |
| `handoffAutoClose` | 交接成功后询问是否关闭本窗口 |
| `windowSubagent` | 开新窗口执行角色（`subagent`）。关掉后策略里不出现开窗说明，调用被拦截 |
| `inlineSubagent` | 窗口内子代理（`subagent_inline`）。关掉后策略里不出现对应说明，调用被拦截 |
| `handoff` | 交接与无关新任务开新窗口（`handoff_open`、`/route handoff`，herdr 中的 `/route new` 与 `>>`）。关掉后策略里不出现交接说明，调用与命令被拦截；`/route new` 与 `>>` 改走窗口内（若窗口内也关了则提示不可用） |

关掉的工具会从模型可见工具集中移除（`setActiveTools`），并以 `tool_call` 拦截作兜底。

## 行为规则文件

注入系统提示的策略分两部分：

- **事实**（代码生成）：可用模型表、当前环境下可用的工具与角色（受 herdr 和 `features` 影响）、交接目录与写法。
- **行为规则**（外部 markdown）：何时使用/不使用子代理、并行结果如何处理、用户说「在这里做」时照做、方案代价说明等。

默认读取 `<pi 配置目录>/task-router.policy.md`（可用 `policyFile` 覆盖，支持 `~`）。文件存在则用其内容；不存在或读取失败则用内置默认，并给出 warning，不暂停路由。规则文件支持占位符 `{{handoffDir}}`，由代码替换。`policyAppend` 仍追加在末尾。

仓库中的 `task-router.policy.example.md` 与内置默认相同。扩展在配置目录尚无该文件时会写入一份，方便直接改。

### 子代理约定

被分派的子代理（开新窗口或窗口内，与 `spawning` 无关；`handoff_open` 开的是普通会话，不注入）启动时，注入 `<pi 配置目录>/task-router.worker.md`：只依据任务提示词、不扩大范围、有歧义时询问、资源安全规则、默认汇报格式（角色另有格式时以角色为准）。占位符 `{{ask}}` 按执行方式替换：开新窗口为“用 caller_ping 询问调用方”，窗口内为“停止执行并在汇报中说明”。

文件不存在时写入内置默认，读取失败时回退内置默认并给出 warning。路由暂停时仍然注入。

### 内置默认行为规则

内置默认：在本会话完成编码、验证和小杂务，不要主动调用 `subagent` / `subagent_inline` / `handoff_open`。只有用户明确要求（如「开子代理」「派给某个角色」「让某个角色验一下」「交接」「开新窗口」，或 `>>`、`/route new`、`/route handoff`）时才使用。认为某步适合拆出去时可以一句话建议，由用户决定。

## 不在 herdr 中运行时

是否在 herdr 中，以环境变量 `HERDR_ENV=1` 且存在 `HERDR_PANE_ID` 判断。不在 herdr 中时：

- **不可用**：开新窗口分派、`handoff_open` 工具（不注册）、交接后自动关闭窗口。
- **改变行为**：所有可分派角色都用 `subagent_inline` 窗口内执行，`dispatch.inlineRoles` 不再起作用；`/route new` 和 `>>` 的新任务也在窗口内执行；`/route handoff` 只生成交接提示词，由你在新会话中使用。
- **不受影响**：`@代号` 指定模型、分派确认、请求失败切 fallback、上下文提醒。

在 herdr 中但没有安装 pi-herdr-subagents 时，`subagent` 工具不存在，开新窗口的角色无法分派；`handoff_open`（交接与无关新任务）和交接后自动关闭仍然可用。这种情况下把所有可分派角色写进 `dispatch.inlineRoles`。

## 更新与卸载

- 更新：`pi update git:github.com/Jayna97/pi-task-router`。只更新扩展代码，已复制的角色文件不会变，需要时自行对比合并。
- 卸载：`pi remove git:github.com/Jayna97/pi-task-router`，再删除 `~/.pi/agent/agents/` 中属于本包的角色文件（注意不要误删自己写的同名角色），以及可选的 `~/.pi/agent/task-router.json`。

## 项目结构

```text
pi-task-router/
├── package.json               # pi 包清单，声明两个扩展
├── task-router.example.json   # 配置示例
├── task-router.policy.example.md  # 行为规则示例（同内置默认）
├── extensions/
│   ├── task-router.ts         # 分派策略与确认、交接、失败切 fallback
│   └── inline-subagent/
│       ├── index.ts           # subagent_inline 工具
│       └── agents.ts          # 角色发现
└── agents/                    # 角色文件，需复制到 ~/.pi/agent/agents/
    ├── verifier.md            # 验证（占位）
    └── chore.md               # 杂务（占位）
```

## 说明

- **启动检查**：每个会话提示一次。pi 低于 1.3.0 时提示升级；在 herdr 中但没有 `subagent` 工具时，提示安装 pi-herdr-subagents 或把可分派角色写入 `dispatch.inlineRoles`；Windows 上在 herdr 中但 PATH 里没有 bash 时，提示加入 Git Bash 的 `bin` 目录。不在 herdr 中时不做 herdr 相关提示。`/route status` 会显示这些检查结果。Windows 上 `handoff_open` 用 `pi.cmd` 启动，不走 herdr `agent start --kind pi`（后者会打到 npm 无扩展脚本）。推理模型若当前思考档是 `off`（从非推理模型切过来，或中继未声明 thinkingLevelMap），会抬到 `medium`。
- **请求失败切 fallback**：当前模型请求失败且不是 fallback 模型时，提示切换到 `fallback`。
- **上下文过长提醒**：超过 `contextWarn` 阈值时提示用 `/route handoff` 写交接说明并在新窗口接手，每项每会话只提醒一次。
- **配置无效时**：缺少配置文件、JSON 无效或校验失败时暂停自动路由（不注入分派策略），启动时提示错误；分派确认仍生效，但不会超时自动执行。
- **统计未完成子窗口**：`/route handoff` 和上下文提醒前会读取 pi-herdr-subagents 的内部运行状态，统计本会话派生的未完成子窗口。这不是公开 API，读不到时按 0 处理，不拦截交接。
