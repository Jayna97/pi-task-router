# 配置与角色参考

以下路径以 `~/.pi/agent/` 为例；设置了 `PI_CODING_AGENT_DIR` 时，以该目录为准。

## 配置

用 `/route setup` 创建 `task-router/config.json`，或复制[配置示例](../task-router.example.json)后手动修改。改完用 `/reload` 加载，`/route status` 可查看生效情况。

| 字段 | 作用 |
|---|---|
| `dispatch.inlineRoles` | 在 herdr 中也改用窗口内执行的角色名数组；没有 herdr 时不需要靠它分流。未安装 pi-herdr-subagents 时，可把要使用的角色都列在这里。 |
| `confirmTimeoutSec` | 新窗口分派确认等待多少秒后自动执行。有效配置省略该字段时为 `30`；`0` 表示等待你确认，不自动执行。 |
| `dispatch.inlineConfirmTimeoutSec` | 窗口内分派的确认时限，省略时为 `10` 秒，`0` 不自动执行。`/route setup` 生成的配置将两种时限都设为 `0`。 |
| `contextWarn` | 上下文提醒阈值。`tokens` 默认 `[300000]`，`[]` 关闭 token 阈值；`percent` 默认不设，取值大于 `0` 且不超过 `100`；`userTurns` 默认 `20`，`0` 关闭轮数阈值。达到任一阈值只提醒，不自动交接或压缩。 |
| `policyFile` | 行为规则文件路径，支持 `~`，默认 `task-router/policy.md`。 |
| `policyAppend` | 附加在行为规则末尾的文字。 |

手动配置时保留 `dispatch`、`dispatch.inlineRoles` 和 `features`，即使只是空数组或空对象。分派确认可以用 `/route confirm on` 或 `/route confirm off` 临时切换。

### 功能开关

以下键都写在 `features` 中，省略时为 `true`。

| 键 | 控制的功能 |
|---|---|
| `confirm` | 子代理分派前确认。 |
| `contextWarn` | 上下文过长提醒。 |
| `handoffAutoClose` | 普通交接成功后关闭原窗口；独立新任务和失败接续不受影响。 |
| `windowSubagent` | 开新窗口执行子代理，包括 `>>`。 |
| `inlineSubagent` | 在当前窗口执行子代理。 |
| `handoff` | 普通交接和独立新任务开窗。关闭后独立新任务改走窗口内执行（需开启 `inlineSubagent`）；失败接续不受影响。 |

## 角色

角色文件放在 `agents/` 下。可复制 [chore](../agents/chore.md) 或 [verifier](../agents/verifier.md) 做模板，把 `model` 改成可用的完整 `provider/id`，或删掉它以继承调用方。

| Frontmatter 字段 | 作用 |
|---|---|
| `name` | 角色名，省略时用文件名。 |
| `description` | 角色用途，用于分派；窗口内角色也需填写。 |
| `model`、`thinking` | 默认模型和思考等级，可在分派时覆盖；未设置时继承调用方。 |
| `tools` | 可用工具，支持逗号分隔或数组；未设置时不限制。 |
| `spawning` | `false` 时，该角色作为子代理不能继续分派。 |
| `disable-model-invocation` | `true` 时不列入分派策略，但仍可按名字显式调用。 |

正文是角色指令，可以留空。`auto-exit`、`interactive`、`system-prompt`、`skills` 等额外字段用于开新窗口的角色，由 [pi-herdr-subagents](https://github.com/0xRichardH/pi-herdr-subagents) 处理。

## 行为规则

参考[行为规则示例](../task-router.policy.example.md)。要覆盖默认规则，编辑 `task-router/policy.md` 或设置 `policyFile`；只想补几条则用 `policyAppend`。子代理的任务边界和汇报约定可在 `task-router/worker.md` 中调整。
