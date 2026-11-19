# pi-task-router

为 [Pi](https://github.com/earendil-works/pi) 提供显式子代理分派、任务交接和独立会话启动。默认留在当前会话，只有你要求时才分派或开新会话。

## 主要功能

- **单窗口为主**：消息默认都在本会话处理，不对消息做自动判断或分流。只有用户主动使用命令/前缀（见[命令与前缀](#命令与前缀)），或在消息中明确要求开新窗口、子代理、交接时才分派。
- **行为规则外置**：何时分派等规则写在 markdown 文件里，随模型能力变化只改规则文件，不改代码。
- **分派前确认**：拦截 `subagent` / `subagent_inline` 调用，可执行、查看或编辑任务、换模型、取消；超时自动执行（可关闭）。
- **[请求失败后接续](#请求失败后接续)**：在 herdr 中，模型请求最终失败后可选模型并在新窗口从已有进度接续；不切换原窗口的模型，不自动发送请求。
- **`subagent_inline`**：在当前窗口另起 `pi` 子进程同步执行角色任务，结果直接作为工具返回值，不开新窗口。
- **角色**：从 `~/.pi/agent/agents/*.md` 读取，格式与字段含义沿用 pi-herdr-subagents；task-router 不定义私有字段和特殊角色名。本包自带占位角色 `verifier`（验证）、`chore`（杂务）。

## 命令与前缀

**上下文够用就直接继续。** 需要换会话接着做同一个任务，用 `<<` 交接；只想在当前会话腾空间、且较早的内容可以概括时，手动输入 Pi 的 `/compact [说明]`。另起无关任务用 `>>>`，不会关闭当前会话。

### `/route` 命令

| 命令 | 作用 |
|---|---|
| `/route` 或 `/route status` | 显示当前模型、上下文用量、配置文件、分派确认开关、herdr 状态、各角色的执行方式（窗口内 / 新窗口）、功能开关、行为规则与子代理约定文件，以及配置警告和启动检查结果。无法识别的子命令也显示状态 |
| `/route setup` | 在交互会话中引导创建缺失的配置，保存后重新加载；不覆盖已有文件 |
| `/route handoff [说明]` | 把当前任务交接到新窗口：让当前 agent 写交接说明到 `~/.pi/agent/task-router/handoff/<名称>-<日期时间>.md`（目标、进度、关键决定、相关文件、未完成步骤、注意事项、「第一步」），再用 `handoff_open` 开普通会话接手，默认沿用当前模型和思考等级（`说明` 里指定了模型时按指定）。`说明` 会作为补充要求附上。还有未完成的子窗口时先询问等待还是强制交接；新会话成功启动并收到交接指令后，原会话在本轮结束时自动关闭（`features.handoffAutoClose`），开窗或发送失败则保留。不在 herdr 中时只输出交接提示词。`features.handoff=false` 时不可用 |
| `/route new <任务>` | 把一个与当前会话无关的新任务分派出去，不在本会话执行：herdr 中用 `handoff_open` 开普通会话，默认继承当前模型和思考等级；否则用 `subagent_inline` 窗口内执行，默认使用角色配置 |
| `/route confirm on` / `/route confirm off` | 本次运行中开 / 关分派前确认（初始值为 `features.confirm`）。`/route confirm` 不带参数等同 `on` |

### 消息前缀

| 前缀 | 作用 |
|---|---|
| `<< [说明]` | 与 `/route handoff [说明]` 相同。例如 `<< 原样附上最初需求，新会话先跑测试` |
| `>> <任务>` | 在 herdr 中开一个一次性子代理窗口，默认使用当前模型和思考等级。完成后自动关窗并回传结果。例如 `>> 检查这次改动有没有遗漏` |
| `>>> <任务>` | 与 `/route new <任务>` 相同，在 herdr 中开独立普通会话。例如 `>>> 整理下载目录` |

#### `>>` 的子代理布局

布局由 `pi-herdr-subagents` 控制。未设置 `PI_SUBAGENT_LAYOUT` 时，`>>` 默认开新 tab。若想用当前 tab 的右侧分屏，在 herdr 中启动 Pi 前执行：

```sh
export PI_SUBAGENT_LAYOUT=split
```

想在下方分屏，用 `PI_SUBAGENT_LAYOUT=split:down`。此设置需要在每台设备上单独配置，更新 task-router 不会改变默认布局。它也影响其他 `subagent` 调用，但 `<<` 交接和 `>>>` 新任务仍开普通 tab。

### 自然语言要求

在消息中明确说「开子代理」「派给某个角色」「让某个角色验一下」「交接」「开新窗口」等，由当前模型按行为规则调用对应工具：

| 工具 | 作用 |
|---|---|
| `subagent_inline` | 窗口内同步执行角色任务（单个或 `tasks` 并行），结果直接返回 |
| `subagent` | 开新 herdr 窗口执行角色任务（pi-herdr-subagents 提供），完成后结果回传 |
| `handoff_open` | 读取 `~/.pi/agent/task-router/handoff/` 下的说明文件，在新 tab 开普通 pi 会话，结果不回传（仅 herdr 中注册）。新 tab 放在当前 tab 之后（同一窗口多次交接按 [1]、[2]… 依次排列；herdr 不支持 `tab.move` 时留在末尾）。`model`、`thinking` 可省略，省略时沿用当前会话的模型和思考等级 |

可以直接说「用 Grok 跑这项子任务」或 `>>> 用 Grok 整理测试方案`。agent 通过只读工具 `route_available_models` 查询 Pi 本地已配置凭据的模型，按显示名和完整 `provider/id` 匹配；找不到或有多条合理线路时先问，不发探测请求。切换**当前会话**仍用 Pi 原生 `/model`。

另有只读工具 `context_usage`：返回当前会话的上下文 token 估计、窗口大小与占用百分比，供 skill 或规则判断是否需要提醒。始终注册，不受 `features` 影响。

`subagent` / `subagent_inline` 调用前会弹出确认（`features.confirm`）：执行、查看或编辑任务、换模型（从 Pi 本地可用模型中选；并行时为全部使用同一模型）、取消；超时按 `confirmTimeoutSec` / `dispatch.inlineConfirmTimeoutSec` 自动执行（编辑或换模型后不再自动执行），Esc 取消。

## 请求失败后接续

在 herdr 中，普通 Pi 会话已保存到磁盘，且 Pi 的自动重试和恢复结束后模型请求仍失败，才会弹出「在新窗口接续 / 留在这里」。手动中止、单个工具报错和子代理会话不触发。选择接续后，在原窗口从 Pi 的本地可用模型中为新窗口选一个。取消就不开窗；原窗口不会换模型或关闭。

新窗口用 Pi 原生 `--fork` 复制开窗时已保存的会话历史，保留失败轮中已有的工具记录，不回退、不写总结。两个窗口共享工作目录。新窗口核对会话来源和实际启用的模型后，才在输入框中填入接续草稿。你可以编辑，按 Enter 才会发送。此流程与 `<<` 普通交接独立，不受交接后自动关窗设置影响。

## 快速开始

### 依赖

- [pi](https://github.com/earendil-works/pi) ≥ 1.3.0，必需。
- [herdr](https://herdr.dev)，可选。开新窗口分派、交接、独立新任务和请求失败后接续都需要在 herdr 中运行 Pi。
- [pi-herdr-subagents](https://github.com/0xRichardH/pi-herdr-subagents)，提供开新窗口分派的 `subagent` 工具：`pi install npm:pi-herdr-subagents`。Windows 上使用该工具还需要 PATH 中有 bash，例如把 Git Bash 的 `bin` 目录加入 PATH。

不使用 herdr 时的行为见下文[不在 herdr 中运行时](#不在-herdr-中运行时)。

### 安装

```bash
pi install git:github.com/Jayna97/pi-task-router
```

安装时请检查 herdr 与 pi-herdr-subagents 是否已安装；缺失时告诉用户会失去哪些功能（见[不在 herdr 中运行时](#不在-herdr-中运行时)），并询问是否安装。

包会被克隆到 pi 配置目录下的 `git/github.com/Jayna97/pi-task-router`。pi 配置目录默认是 `~/.pi/agent`，设置了 `PI_CODING_AGENT_DIR` 时跟随该变量（角色在其下的 `agents/`，task-router 自己的配置、规则文件和交接说明都在其下的 `task-router/`）。下文的 `~/.pi/agent/...` 均指该目录。不要再把扩展文件另外放进 `~/.pi/agent/extensions/`，否则会重复注册工具。

### 首次配置

安装后启动 Pi（已在运行可用 `/reload`）。如果没有 `~/.pi/agent/task-router/config.json`，启动提示和 `/route status` 会提示输入 **`/route setup`**，不会弹窗打断会话。

选择是否开启上下文提醒；在 herdr 里还会询问交接成功后是否自动关闭原窗口。答完直接创建 `config.json` 并重新加载，不需要配置模型。答完前按 Esc 可取消，不写配置。已有配置（即使无效）不会被覆盖；后续调整直接编辑文件并 `/reload`。

引导生成的配置默认开启分派确认，不会超时自动执行。引导不会安装角色。如果你已经有 `chore` 或 `verifier`，引导会把它们设为窗口内角色；在 herdr 中未安装 `pi-herdr-subagents` 时，会把已发现的可分派角色都设为窗口内执行。想使用本包的示例角色，可先复制角色文件、调整模型，再运行引导。

### 手动配置：直接用自带角色和示例配置

1. 把包里 `agents/` 下的两个角色文件**复制**到 `~/.pi/agent/agents/`（已有同名文件时自行合并）。不要用软链接：`pi update` 会重置克隆目录，`pi remove` 会删除克隆目录。
2. 把 `task-router.example.json` 复制为 `~/.pi/agent/task-router/config.json`。
3. 把 `verifier.md`、`chore.md` frontmatter 中的 `model`（`provider/id`）换成你有凭据的模型；也可去掉该字段，继承调用方模型。

### 用自己的角色

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

角色说明只以角色文件为准。`config.json` 中与角色相关的配置只有：

- `dispatch.inlineRoles` 列出在 herdr 中也走窗口内执行的角色，其余可分派角色开新窗口。

配置引用了不存在的角色时，该项会被忽略并给出警告。

### 配置字段

配置文件为 `~/.pi/agent/task-router/config.json`，字段如下：

| 字段 | 含义 |
|---|---|
| `contextWarn` | 可选，`{ tokens, percent, userTurns }`，达到阈值时提示可按需交接或手动压缩，每项每会话提醒一次。`tokens` 为 token 数数组，缺省 `[300000]`，空数组不按 token 提醒；`percent` 为上下文窗口占用百分比，缺省不按百分比提醒；`userTurns` 为用户消息轮数，缺省 `20`，`0` 不按轮数提醒 |
| `confirmTimeoutSec` | 新窗口分派确认的自动执行秒数，`0` 关闭 |
| `dispatch.inlineRoles` | 在 herdr 中也走 `subagent_inline` 的角色 |
| `dispatch.inlineConfirmTimeoutSec` | 窗口内分派确认的自动执行秒数，`0` 关闭 |
| `features` | 功能开关，均为可选布尔值，缺省 `true`。见下文 |
| `policyFile` | 可选，行为规则 markdown 路径（支持 `~`），缺省 `<pi 配置目录>/task-router/policy.md` |
| `policyAppend` | 可选，追加到分派规则末尾的文字 |

配置完成后启动 `pi`，用 `/route status` 确认配置已加载。

### features

写在 `features` 对象下，全部可选，缺省 `true`。旧配置不写新键时仍正常加载。

| 键 | 作用 |
|---|---|
| `confirm` | 分派前确认 |
| `contextWarn` | 上下文过长提醒 |
| `handoffAutoClose` | `/route handoff` 或 `<<` 成功后自动关闭来源窗口；关闭此开关则保留。`/route new` 和 `>>>` 不受影响 |
| `windowSubagent` | 开新窗口执行子代理（`subagent`，包括 `>>`）。关掉后策略里不出现开窗说明，调用被拦截 |
| `inlineSubagent` | 窗口内子代理（`subagent_inline`）。关掉后策略里不出现对应说明，调用被拦截 |
| `handoff` | 交接与无关新任务开新窗口（`handoff_open`、`/route handoff`、`<<`，herdr 中的 `/route new` 与 `>>>`）。关掉后策略里不出现交接说明，交接工具和命令不可用；`/route new` 与 `>>>` 改走窗口内（若窗口内也关了则提示不可用），Pi 的 `/compact` 不受影响 |

关掉的工具会从模型可见工具集中移除（`setActiveTools`），并以 `tool_call` 拦截作兜底。

## 行为规则文件

注入系统提示的策略分两部分：

- **事实**（代码生成）：模型继承与匹配规则、当前环境下可用的工具与角色（受 herdr 和 `features` 影响）、交接目录与写法。
- **行为规则**（外部 markdown）：何时使用/不使用子代理、并行结果如何处理、用户说「在这里做」时照做、方案代价说明等。

默认读取 `<pi 配置目录>/task-router/policy.md`（可用 `policyFile` 覆盖，支持 `~`）。文件存在则用其内容；不存在或读取失败则用内置默认，并给出 warning，分派规则照常注入。规则文件支持占位符 `{{handoffDir}}`，由代码替换。`policyAppend` 仍追加在末尾。

仓库中的 `task-router.policy.example.md` 与内置默认相同。扩展在 `task-router/` 下尚无该文件时会写入一份，方便直接改。

### 子代理约定

被分派的子代理（开新窗口或窗口内，与 `spawning` 无关；`handoff_open` 开的是普通会话，不注入）启动时，注入 `<pi 配置目录>/task-router/worker.md`：只依据任务提示词、不扩大范围、有歧义时询问、资源安全规则、默认汇报格式（角色另有格式时以角色为准）。占位符 `{{ask}}` 按执行方式替换：开新窗口为“用 caller_ping 询问调用方”，窗口内为“停止执行并在汇报中说明”。

文件不存在时写入内置默认，读取失败时回退内置默认并给出 warning。配置无效（不注入分派规则）时仍然注入。

### 内置默认行为规则

内置默认：在本会话完成编码、验证和小杂务，不要主动调用 `subagent` / `subagent_inline` / `handoff_open`。只有用户明确要求（如「开子代理」「派给某个角色」「让某个角色验一下」「交接」「开新窗口」，或 `>>`、`>>>`、`<<`、`/route new`、`/route handoff`）时才使用。认为某步适合拆出去时可以一句话建议，由用户决定。

## 不在 herdr 中运行时

是否在 herdr 中，以环境变量 `HERDR_ENV=1` 且存在 `HERDR_PANE_ID` 判断。不在 herdr 中时：

- **不可用**：开新窗口分派（包括 `>>`）、`handoff_open` 工具（不注册）、交接后自动关闭窗口、请求失败后在新窗口接续。
- **改变行为**：所有可分派角色都用 `subagent_inline` 窗口内执行，`dispatch.inlineRoles` 不再起作用；`/route new` 和 `>>>` 的新任务也在窗口内执行；`/route handoff` 和 `<<` 只生成交接提示词，由你在新会话中使用。
- **不受影响**：Pi 的 `/compact` 和 `/model`、分派确认、上下文提醒。

在 herdr 中但没有安装 pi-herdr-subagents 时，`subagent` 工具不存在，开新窗口的角色无法分派；`handoff_open`（交接与无关新任务）、交接后自动关闭和请求失败后接续仍然可用。这种情况下把所有可分派角色写进 `dispatch.inlineRoles`。

## 更新与卸载

- 更新：`pi update git:github.com/Jayna97/pi-task-router`。只更新扩展代码，已复制的角色文件不会变，需要时自行对比合并。
- 卸载：`pi remove git:github.com/Jayna97/pi-task-router`，再删除 `~/.pi/agent/agents/` 中属于本包的角色文件（注意不要误删自己写的同名角色），以及 `~/.pi/agent/task-router/` 目录（配置、规则文件和交接说明）。

## 项目结构

```text
pi-task-router/
├── package.json               # pi 包清单，声明两个扩展
├── task-router.example.json   # 配置示例
├── task-router.policy.example.md  # 行为规则示例（同内置默认）
├── extensions/
│   ├── task-router.ts         # 分派策略与确认、交接
│   ├── herdr-subagents.ts     # 对 pi-herdr-subagents 的全部依赖（工具名、环境变量、内部状态）
│   └── inline-subagent/
│       ├── index.ts           # subagent_inline 工具
│       └── agents.ts          # 角色发现
└── agents/                    # 角色文件，需复制到 ~/.pi/agent/agents/
    ├── verifier.md            # 验证（占位）
    └── chore.md               # 杂务（占位）
```

## 说明

- **启动检查**：每个会话提示一次。pi 低于 1.3.0 时提示升级；在 herdr 中但没有 `subagent` 工具时，提示安装 pi-herdr-subagents 或把可分派角色写入 `dispatch.inlineRoles`；Windows 上在 herdr 中但 PATH 里没有 bash 时，提示加入 Git Bash 的 `bin` 目录。不在 herdr 中时不做 herdr 相关提示。`/route status` 会显示这些检查结果。Windows 上 `handoff_open` 用 `pi.cmd` 启动，不走 herdr `agent start --kind pi`（后者会打到 npm 无扩展脚本）。推理模型若当前思考档是 `off`（从非推理模型切过来，或中继未声明 thinkingLevelMap），会抬到 `medium`。
- **上下文过长提醒**：达到 `contextWarn` 阈值时，提示可用 `<<` 交接，或手动输入 `/compact` 原地压缩，不会自动执行。每项每会话只提醒一次。
- **未配置或配置无效时**：缺少配置文件时提示 `/route setup`；JSON 无效或校验失败时提示错误，不覆盖文件。两种情况下都不注入分派规则；分派确认仍生效，但不会超时自动执行。
- **统计未完成子窗口**：`/route handoff` 和上下文提醒前会读取 pi-herdr-subagents 的内部运行状态，统计本会话派生的未完成子窗口。这不是公开 API，读不到时按 0 处理，不拦截交接。
