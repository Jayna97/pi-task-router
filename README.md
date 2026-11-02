# pi-task-router

会话级模型选择 + 分派策略（`task-router`），以及当前窗口内同步执行子代理的 `subagent_inline`。

这是个人项目，不做主要支持。能用就用，坏了请自行改。

## 功能

- **task-router**：根据 `~/.pi/agent/task-router.json` 做会话首条消息选模型、后续消息分流（子任务 / 无关新任务）、分派前确认、上下文过长提醒、不稳定模型出错时切 fallback。
- **角色**：只从 `~/.pi/agent/agents/*.md` 读取（支持软链接）。`session` 与 `dispatch: false` 的角色不分派。
- **inline-subagent**：注册 `subagent_inline`，在当前窗口另起 `pi` 子进程同步执行，结果作为工具返回值交回，不开新 herdr 窗口。
- 不在 herdr 中时：全部改为窗口内执行（`subagent_inline`）；`session` 交接与 `/route handoff`、`/route new` 不可用。

## 依赖

- [pi coding agent](https://github.com/badlogic/pi-mono)（必需）
- [pi-herdr-subagents](https://github.com/0xRichardH/pi-herdr-subagents)（开新窗口分派 `subagent` 时必需；也请用 `pi install` 安装）
- [herdr](https://herdr.dev)（可选。不在 herdr 中时，task-router 把可分派角色全部改为 `subagent_inline`）

## 安装

其他人：

```bash
pi install git:github.com/<owner>/pi-task-router
```

自己的其他设备：clone 本仓库后按本地路径安装（写入 `~/.pi/agent/settings.json`）：

```bash
git clone <本仓库 URL>
pi install /path/to/pi-task-router
```

不要同时把扩展放进 `~/.pi/agent/extensions/` 再 `pi install`，否则会重复加载、工具重复注册。

## 角色文件

本包的 `agents/*.md` **不会**随 `pi install` 自动生效。pi-herdr-subagents、task-router、inline-subagent 都只从 `~/.pi/agent/agents/` 读角色。

请手动复制或建软链接：

```bash
mkdir -p ~/.pi/agent/agents
ln -s /path/to/pi-task-router/agents/coder.md ~/.pi/agent/agents/coder.md
ln -s /path/to/pi-task-router/agents/verifier.md ~/.pi/agent/agents/verifier.md
ln -s /path/to/pi-task-router/agents/chore.md ~/.pi/agent/agents/chore.md
ln -s /path/to/pi-task-router/agents/session.md ~/.pi/agent/agents/session.md
```

或直接复制 `agents/*.md` 到该目录。

## 配置

把示例复制为个人配置（**不要**把填好密钥或个人路径的配置提交回本仓库）：

```bash
cp /path/to/pi-task-router/task-router.example.json ~/.pi/agent/task-router.json
```

缺少配置、JSON 无效或校验失败时：**暂停自动路由**（不注入分派策略、不自动选模型/分流），并在 `session_start` 提示错误。`/route status` 会显示已暂停。

### 字段

| 字段 | 含义 |
|---|---|
| `models` | 代号 → `{ provider, id, desc }`。代号须匹配 `[a-z][a-z0-9_-]*` |
| `default` / `fallback` | 默认模型、不稳定模型失败时的回退，必须是 `models` 中的代号 |
| `unstable` | 出错时提示切到 `fallback` 的代号列表 |
| `analyzer` | `{ type: "classifier" \| "chat", provider, id, timeoutMs }` |
| `relationMinProb` | 分类器判断 relation 的最低置信度（0–1，缺省 0.6） |
| `contextWarn` | `{ tokens: number[], percent, userTurns }`，上下文过长提醒阈值 |
| `roles` | 可选。`{ "<角色名>": { use?, hint? } }`，覆盖分派策略里的用途说明 |
| `confirmTimeoutSec` | 分派确认框自动执行秒数；`0` 关闭 |
| `dispatch.inlineRoles` | 走 `subagent_inline` 的角色名 |
| `dispatch.inlineConfirmTimeoutSec` | 窗口内分派确认超时 |
| `features` | `autoModel` / `relationCheck` / `confirm` / `contextWarn` / `handoffAutoClose`，均为布尔 |
| `policyAppend` | 追加到分派规则末尾，不覆盖内置规则 |

示例里的模型代号（如 `flash` / `grok` / `gpt` / `opus`）只是示例，请改成你自己目录里真实存在、且已配置凭据的模型。

### analyzer 不可用时

1. 先用配置的 analyzer（`classifier` 走 `classify`，`chat` 走当前配置的分析模型）。
2. 失败则提示警告，状态栏标明分析模型不可用，**改用当前会话模型**再分析一次。
3. 当前模型也失败，或当前模型就是 analyzer 本身：返回空结果。首条消息会落到 `default` 模型；后续分流拿不准时当 `continuation`。

## 对 pi-herdr-subagents 内部结构的依赖

task-router 在 herdr 里做 `/route handoff` 前，会读 pi-herdr-subagents 挂在

`globalThis[Symbol.for("pi-subagents/runtime")].runningSubagents`

上的 `Map`，统计**本进程自己派生的**未完成子窗口。读不到（包未加载、结构变了、不是 Map）时按 **0** 处理，即不拦截交接。这不是公开 API，pi-herdr-subagents 升级后可能失效。

## 命令

`/route [status|handoff|new|off|on|confirm on|confirm off]`

前缀：`@代号` 指定首条消息模型；`>>` 强制当作新窗口任务。
