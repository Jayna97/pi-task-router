/**
 * task-router — 会话级模型选择 + 分派策略（执行层由 pi-herdr-subagents 负责）
 *
 * - 配置：只读 pi 配置目录（getAgentDir()）下的 task-router.json；读取或校验失败时暂停自动路由（不注入分派策略），session_start 提示错误
 * - 不自动选模型、不判断消息；只有用户主动用 >>、/route new 或在消息中明确要求时才分派
 * - 拦截 subagent / subagent_inline：确认 / 编辑任务 / 换模型 / 取消（超时自动执行，0 关闭）
 * - auto-exit 与 interactive 只对新窗口执行（subagent）生效；窗口内执行不读这两项
 * - 上下文过长：提醒 /route handoff 交接
 * - 当前模型请求失败（stopReason 为 error）且不是 fallback 本身：提供切换到 fallback
 * - /route [status|handoff|new|confirm on|confirm off]（status 含确认超时秒数）
 * - 前缀：@代号 指定首条消息模型（代号见配置 models）；>> 强制当作新任务（herdr 开窗，否则窗口内）
 *
 * 角色定义：由 inline-subagent/agents.ts 从 pi 配置目录下的 agents/*.md 读取；字段与含义沿用 pi-herdr-subagents（disable-model-invocation: true 的角色不列入分派策略；spawning: false 禁止继续分派）。task-router 不定义私有字段和特殊角色名。
 * 无关新任务（>>、/route new）：herdr 中写任务说明并用 handoff_open 开普通会话；否则窗口内执行
 * features：confirm / contextWarn / handoffAutoClose / windowSubagent / inlineSubagent / handoff（缺省 true）
 * policyFile：行为规则 markdown（缺省 <agentDir>/task-router.policy.md）；policyAppend 追加到末尾
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Type } from "typebox";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverAgents, shouldDenySpawning, type AgentConfig } from "./inline-subagent/agents.ts";

/** 老版本可能没有 VERSION 导出；命名空间导入避免加载失败。 */
const PI_VERSION: unknown = (piCodingAgent as { VERSION?: unknown }).VERSION;
const MIN_PI_VERSION = "1.3.0";

/** 解析 major.minor.patch，可带 prerelease / build；无法解析返回 undefined。 */
function parsePiVersion(v: unknown): { major: number; minor: number; patch: number; prerelease: boolean } | undefined {
	if (typeof v !== "string") return undefined;
	const m = v.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
	if (!m) return undefined;
	return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: !!m[4] };
}

/** 语义版本比较：a < min 为 true。VERSION 缺失或无法解析时返回 false（不提示）。 */
function isPiVersionBelow(version: unknown, min: string = MIN_PI_VERSION): boolean {
	const a = parsePiVersion(version);
	const b = parsePiVersion(min);
	if (!a || !b) return false;
	if (a.major !== b.major) return a.major < b.major;
	if (a.minor !== b.minor) return a.minor < b.minor;
	if (a.patch !== b.patch) return a.patch < b.patch;
	return a.prerelease && !b.prerelease;
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ───────────────────────── 配置 ─────────────────────────
// 只读 pi 配置目录（getAgentDir()）下的 task-router.json，不做内置默认深合并。代号限 [a-z][a-z0-9_-]*
// confirmTimeoutSec：分派确认框首次弹出后的自动执行秒数（缺省 30；0 关闭；Esc 仍拦截）
// 角色说明只以角色文件为准（roles 已废弃，写了会被忽略并警告）
// features：confirm / contextWarn / handoffAutoClose / windowSubagent / inlineSubagent / handoff（缺省 true）
// policyFile：行为规则 markdown 路径（支持 ~）；policyAppend 追加到末尾（不覆盖）

type Pick = string;
type Level = "low" | "medium" | "high";
type ModelSpec = { provider: string; id: string; desc: string };
type FeatureKey =
	| "confirm"
	| "contextWarn"
	| "handoffAutoClose"
	| "windowSubagent"
	| "inlineSubagent"
	| "handoff";
type Features = Record<FeatureKey, boolean>;
interface RouterConfig {
	models: Record<string, ModelSpec>;
	fallback: string;
	contextWarn: { tokens: number[]; percent: number; userTurns: number };
	/** 分派确认框首次弹出后的自动执行秒数；0 关闭 */
	confirmTimeoutSec: number;
	/** 窗口内执行：哪些角色走 subagent_inline，以及其确认超时 */
	dispatch: { inlineRoles: string[]; inlineConfirmTimeoutSec: number };
	features: Features;
	/** 追加到分派规则末尾 */
	policyAppend: string;
	/** 行为规则 markdown 路径 */
	policyFile: string;
}

const FEATURE_KEYS: FeatureKey[] = [
	"confirm",
	"contextWarn",
	"handoffAutoClose",
	"windowSubagent",
	"inlineSubagent",
	"handoff",
];
const DEFAULT_POLICY_PATH = join(getAgentDir(), "task-router.policy.md");
/** 子代理通用约定（固定路径，缺失时写入内置默认） */
const WORKER_POLICY_PATH = join(getAgentDir(), "task-router.worker.md");

const CONFIG_PATH = join(getAgentDir(), "task-router.json");
const CLOSE_LOG_PATH = join(getAgentDir(), "task-router-close.log");
const HANDOFF_DIR = join(getAgentDir(), "handoff");
/** 给人/模型看：正斜杠，避免 JSON 把 Windows 路径里的 \t 等当成转义。 */
const HANDOFF_DIR_PROMPT = HANDOFF_DIR.replaceAll("\\", "/");
const PICK_NAME_RE = /^[a-z][a-z0-9_-]*$/;
const AGENTS_DIR = join(getAgentDir(), "agents");

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function optNum(v: unknown, fallback: number, label: string): number {
	if (v == null) return fallback;
	return reqNum(v, label);
}

function reqStr(v: unknown, label: string): string {
	if (typeof v !== "string" || !v.trim()) throw new Error(`${label} 必须是非空字符串`);
	return v.trim();
}

function reqNum(v: unknown, label: string): number {
	if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${label} 必须是有限数字`);
	return v;
}

function reqBool(v: unknown, label: string): boolean {
	if (typeof v !== "boolean") throw new Error(`${label} 必须是布尔值`);
	return v;
}

function optBool(v: unknown, fallback: boolean, label: string): boolean {
	if (v == null) return fallback;
	return reqBool(v, label);
}

function expandUserPath(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/") || (process.platform === "win32" && p.startsWith("~\\"))) {
		return join(homedir(), p.slice(2));
	}
	return p;
}

/** 角色读取与 inline-subagent 共用一份实现（inline-subagent/agents.ts） */
function loadAgents(): { agents: AgentConfig[]; warnings: string[] } {
	if (!existsSync(AGENTS_DIR)) return { agents: [], warnings: [`角色目录不存在：${AGENTS_DIR}`] };
	try {
		return { agents: discoverAgents(), warnings: [] };
	} catch (e: any) {
		return { agents: [], warnings: [`读取角色目录失败（${String(e?.message ?? e).slice(0, 120)}）`] };
	}
}

const AGENT_LOAD = loadAgents();
const AGENT_BY_NAME = new Map(AGENT_LOAD.agents.map((a) => [a.name, a]));
const DISPATCHABLE_ROLES = AGENT_LOAD.agents.filter((a) => !a.disableModelInvocation).map((a) => a.name);
const DISPATCHABLE_SET = new Set(DISPATCHABLE_ROLES);

function validateConfig(raw: unknown): { cfg: RouterConfig; warnings: string[] } {
	if (!isPlainObject(raw)) throw new Error("配置必须是对象");
	if (!isPlainObject(raw.models) || Object.keys(raw.models).length === 0) throw new Error("models 不能为空");
	const models: Record<string, ModelSpec> = {};
	for (const [k, v] of Object.entries(raw.models)) {
		if (!PICK_NAME_RE.test(k)) throw new Error(`模型代号不合法：${k}（需匹配 [a-z][a-z0-9_-]*）`);
		if (!isPlainObject(v)) throw new Error(`models.${k} 必须是对象`);
		models[k] = { provider: reqStr(v.provider, `models.${k}.provider`), id: reqStr(v.id, `models.${k}.id`), desc: reqStr(v.desc, `models.${k}.desc`) };
	}
	const inModels = (name: string, v: unknown) => {
		const s = reqStr(v, name);
		if (!(s in models)) throw new Error(`${name} 必须是 models 中的代号`);
		return s;
	};
	if (!isPlainObject(raw.contextWarn)) throw new Error("contextWarn 必须是对象");
	const tokens = raw.contextWarn.tokens;
	if (!Array.isArray(tokens) || tokens.length === 0 || tokens.some((t) => typeof t !== "number" || !Number.isFinite(t) || t <= 0))
		throw new Error("contextWarn.tokens 必须是正数数组");
	const percent = reqNum(raw.contextWarn.percent, "contextWarn.percent");
	const userTurns = reqNum(raw.contextWarn.userTurns, "contextWarn.userTurns");
	const warnings: string[] = [];
	if (raw.roles != null) warnings.push("roles 已废弃（角色说明以角色文件为准），已忽略");
	const confirmTimeoutSec = optNum(raw.confirmTimeoutSec, 30, "confirmTimeoutSec");
	if (confirmTimeoutSec < 0) throw new Error("confirmTimeoutSec 必须是非负数（0 关闭自动执行）");
	if (!isPlainObject(raw.dispatch)) throw new Error("dispatch 必须是对象");
	const inlineRolesRaw = raw.dispatch.inlineRoles;
	if (!Array.isArray(inlineRolesRaw) || inlineRolesRaw.some((x) => typeof x !== "string"))
		throw new Error("dispatch.inlineRoles 必须是字符串数组");
	const inlineRoles: string[] = [];
	for (const r of inlineRolesRaw) {
		const agent = AGENT_BY_NAME.get(r);
		if (!agent) {
			warnings.push(`dispatch.inlineRoles 含未知角色「${r}」，已忽略`);
			continue;
		}
		if (!DISPATCHABLE_SET.has(r)) {
			warnings.push(`dispatch.inlineRoles 含不可分派角色「${r}」，已忽略`);
			continue;
		}
		if (!inlineRoles.includes(r)) inlineRoles.push(r);
	}
	const inlineConfirmTimeoutSec = optNum(
		raw.dispatch.inlineConfirmTimeoutSec,
		10,
		"dispatch.inlineConfirmTimeoutSec",
	);
	if (inlineConfirmTimeoutSec < 0) throw new Error("dispatch.inlineConfirmTimeoutSec 必须是非负数（0 关闭自动执行）");
	if (!isPlainObject(raw.features)) throw new Error("features 必须是对象");
	const features = {} as Features;
	for (const k of FEATURE_KEYS) features[k] = optBool(raw.features[k], true, `features.${k}`);
	if (raw.policyAppend != null && typeof raw.policyAppend !== "string") throw new Error("policyAppend 必须是字符串");
	const policyAppend = typeof raw.policyAppend === "string" ? raw.policyAppend : "";
	if (raw.policyFile != null && typeof raw.policyFile !== "string") throw new Error("policyFile 必须是字符串");
	const policyFileRaw = typeof raw.policyFile === "string" ? raw.policyFile.trim() : "";
	const policyFile = resolve(expandUserPath(policyFileRaw || DEFAULT_POLICY_PATH));
	return {
		cfg: {
			models,
			fallback: inModels("fallback", raw.fallback),
			contextWarn: { tokens: tokens as number[], percent, userTurns },
			confirmTimeoutSec,
			dispatch: { inlineRoles, inlineConfirmTimeoutSec },
			features,
			policyAppend,
			policyFile,
		},
		warnings,
	};
}

function joinWarnings(...parts: Array<string | undefined>): string | undefined {
	const s = parts.filter(Boolean).join("\n");
	return s || undefined;
}

/** 配置不可用时的空壳：不自动路由；确认仍开但超时为 0（不自动执行）。 */
function pausedConfig(): RouterConfig {
	return {
		models: {},
		fallback: "",
		contextWarn: { tokens: [], percent: 100, userTurns: Number.MAX_SAFE_INTEGER },
		confirmTimeoutSec: 0,
		dispatch: { inlineRoles: [], inlineConfirmTimeoutSec: 0 },
		features: {
			confirm: true,
			contextWarn: false,
			handoffAutoClose: false,
			windowSubagent: true,
			inlineSubagent: true,
			handoff: true,
		},
		policyAppend: "",
		policyFile: DEFAULT_POLICY_PATH,
	};
}

function loadConfig(): { cfg: RouterConfig; paused: boolean; warning?: string } {
	const agentWarn = AGENT_LOAD.warnings.join("\n") || undefined;
	const pause = (msg: string) => ({
		cfg: pausedConfig(),
		paused: true,
		warning: joinWarnings(`${msg}。已暂停自动路由（不注入分派策略）`, agentWarn),
	});
	if (!existsSync(CONFIG_PATH)) return pause(`${CONFIG_PATH} 不存在`);
	let text: string;
	try {
		text = readFileSync(CONFIG_PATH, "utf8");
	} catch (e: any) {
		return pause(`读取 ${CONFIG_PATH} 失败（${String(e?.message ?? e).slice(0, 120)}）`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (e: any) {
		return pause(`${CONFIG_PATH} JSON 解析失败（${String(e?.message ?? e).slice(0, 120)}）`);
	}
	try {
		const { cfg, warnings } = validateConfig(parsed);
		return { cfg, paused: false, warning: joinWarnings(warnings.join("\n") || undefined, agentWarn) };
	} catch (e: any) {
		return pause(`${CONFIG_PATH} 校验失败（${String(e?.message ?? e).slice(0, 160)}）`);
	}
}

const LOADED = loadConfig();
const CFG = LOADED.cfg;
const ROUTING_PAUSED = LOADED.paused;
const CONFIG_WARNING = LOADED.warning;
const MODELS = CFG.models;
const FALLBACK = CFG.fallback;
const CONTEXT_WARN_TOKENS = CFG.contextWarn.tokens;
const CONTEXT_WARN_PERCENT = CFG.contextWarn.percent;
const USER_TURN_WARN = CFG.contextWarn.userTurns;
const CONFIRM_TIMEOUT_SEC = CFG.confirmTimeoutSec;
const INLINE_ROLES = CFG.dispatch.inlineRoles;
const INLINE_CONFIRM_TIMEOUT_SEC = CFG.dispatch.inlineConfirmTimeoutSec;
const INLINE_ROLE_SET = new Set(INLINE_ROLES);
const DISPATCH_ROLES = DISPATCHABLE_ROLES;
const WINDOW_ROLES = DISPATCH_ROLES.filter((r) => !INLINE_ROLE_SET.has(r));
const FEATURES = CFG.features;
const POLICY_APPEND = CFG.policyAppend.trim();
const POLICY_FILE = CFG.policyFile;
const PICKS = Object.keys(MODELS);
const PICK_ALT = PICKS.join("|") || "_";
const PREFIX_RE = PICKS.length > 0 ? new RegExp(`^@(${PICK_ALT})\\b`, "i") : /$^/;

const IN_HERDR = process.env.HERDR_ENV === "1" && !!process.env.HERDR_PANE_ID;
const IS_WIN32 = process.platform === "win32";

/** Windows 上用 where.exe 查 PATH 中是否有 bash。非 win32 不调用。 */
function windowsBashOnPath(): boolean {
	try {
		execFileSync("where.exe", ["bash"], {
			encoding: "utf8",
			timeout: 5_000,
			stdio: ["ignore", "pipe", "ignore"],
			windowsHide: true,
		});
		return true;
	} catch {
		return false;
	}
}

const WIN_BASH_ON_PATH = IS_WIN32 && IN_HERDR ? windowsBashOnPath() : true;
const PI_VERSION_BELOW_MIN = isPiVersionBelow(PI_VERSION);

/**
 * session_start 时查（extensions.md：工厂在加载期 registerTool，session_start 在全部扩展加载并 bindCore 之后）。
 * 加载期调用 pi.getAllTools() 会抛 “runtime not initialized”。
 */
function hasSubagentTool(pi: ExtensionAPI): boolean {
	try {
		const getAll = pi.getAllTools;
		if (typeof getAll !== "function") return false;
		const tools = getAll.call(pi) as Array<string | { name?: string }>;
		if (!Array.isArray(tools)) return false;
		return tools.some((t) => (typeof t === "string" ? t : t?.name) === "subagent");
	} catch {
		return false;
	}
}

function piVersionStatusLine(): string {
	if (typeof PI_VERSION !== "string" || !parsePiVersion(PI_VERSION)) return "pi 版本：未知";
	if (PI_VERSION_BELOW_MIN) return `pi 版本：${PI_VERSION}（低于 ${MIN_PI_VERSION}）`;
	return `pi 版本：${PI_VERSION}`;
}

function collectRuntimeWarnings(pi: ExtensionAPI): string[] {
	const out: string[] = [];
	if (PI_VERSION_BELOW_MIN && typeof PI_VERSION === "string") {
		out.push(`当前 pi 版本为 ${PI_VERSION}，本扩展需要 ≥ ${MIN_PI_VERSION}，请升级 pi。`);
	}
	if (IN_HERDR && FEATURES.windowSubagent && !hasSubagentTool(pi)) {
		out.push(
			"开新窗口分派不可用：未找到 subagent 工具。请执行 pi install npm:pi-herdr-subagents，或把可分派角色写进 dispatch.inlineRoles。",
		);
	}
	if (IN_HERDR && FEATURES.windowSubagent && IS_WIN32 && !WIN_BASH_ON_PATH) {
		out.push(
			"pi-herdr-subagents 开新窗口需要 bash。请把 Git Bash 的 bin 目录（如 C:\\Program Files\\Git\\bin）加入 PATH。",
		);
	}
	return out;
}

const SUBAGENT_ID = process.env.PI_SUBAGENT_ID; // pi-herdr-subagents 子窗口
const SUBAGENT_ROLE = process.env.PI_SUBAGENT_AGENT ?? "";
const INLINE_SUBAGENT = process.env.PI_INLINE_SUBAGENT === "1";
const INLINE_AGENT = process.env.PI_INLINE_SUBAGENT_AGENT ?? "";
const CURRENT_AGENT = INLINE_SUBAGENT ? INLINE_AGENT : SUBAGENT_ROLE;
/** 子代理且 spawning:false：不选模型、不注入分派规则、不能继续分派、不检测新任务、不弹确认、不提醒上下文 */
function computeIsWorker(): boolean {
	if (!INLINE_SUBAGENT && !SUBAGENT_ID) return false;
	const agent = AGENT_BY_NAME.get(CURRENT_AGENT);
	return agent ? shouldDenySpawning(agent) : false;
}
const IS_WORKER = computeIsWorker();
const EXPLICIT_MODEL = process.argv.some((a) => a === "--model" || a.startsWith("--model="));
const SPAWN_TOOL_NAMES = new Set([
	"subagent",
	"subagent_inline",
	"subagent_interrupt",
	"subagent_resume",
	"subagents_list",
	"handoff_open",
]);

// ───────────────────────── 工具函数 ─────────────────────────

const ref = (p: Pick) => `${MODELS[p].provider}/${MODELS[p].id}`;
const modelTable = (Object.keys(MODELS) as Pick[]).map((k) => `- ${ref(k)}（${k}）：${MODELS[k].desc}`).join("\n");

function branchMessages(ctx: ExtensionContext): any[] {
	return ctx.sessionManager
		.getBranch()
		.filter((e: any) => e.type === "message")
		.map((e: any) => e.message);
}

function routerEntry(ctx: ExtensionContext): any | undefined {
	return ctx.sessionManager
		.getBranch()
		.filter((e: any) => e.type === "custom" && e.customType === "task-router")
		.at(-1)?.data;
}

const asLevel = (v: unknown, d: Level = "medium"): Level => (v === "low" || v === "medium" || v === "high" ? v : d);

function agentDefault(agent: string | undefined, field: "model" | "thinking"): string | undefined {
	if (!agent) return undefined;
	return AGENT_BY_NAME.get(agent)?.[field];
}

const WORKER_DENY_SPAWN = IS_WORKER;

function modelSupportsReasoning(model: { reasoning?: boolean } | undefined): boolean {
	return model?.reasoning === true;
}

/** 推理模型停在 off 时抬到 medium。中继缺 thinkingLevelMap 时，从非推理模型切过来会卡在 off。 */
function ensureThinkingOn(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (IS_WORKER) return;
	if (!modelSupportsReasoning(ctx.model as { reasoning?: boolean } | undefined)) return;
	const lv = ctx.thinkingLevel;
	if (lv && lv !== "off") return;
	pi.setThinkingLevel("medium");
}

async function applyModel(pi: ExtensionAPI, ctx: ExtensionContext, pick: Pick, level: Level): Promise<boolean> {
	const spec = MODELS[pick];
	if (!spec) return false;
	const m = ctx.modelRegistry.find(spec.provider, spec.id);
	if (!m) return false;
	const ok = await pi.setModel(m);
	if (ok) pi.setThinkingLevel(level);
	return ok;
}

type DispatchMode = "inline" | "handoff";

function parseModelPrefix(text: string): { model: Pick; thinking: Level; reason: string } | undefined {
	const m = text.match(PREFIX_RE);
	if (m) return { model: m[1].toLowerCase(), thinking: "medium", reason: "手动指定" };
	return undefined;
}

// ───────────────────────── 系统提示 ─────────────────────────

function roleLine(r: string): string {
	const agent = AGENT_BY_NAME.get(r);
	const use = agent?.description || r;
	const suffix = agent?.model ? `（默认 ${agent.model}）` : "";
	return `${use} → agent: "${r}"${suffix}`;
}

const INLINE_ROLE_LINES = INLINE_ROLES.map((r) => `- ${roleLine(r)}`).join("\n");
const WINDOW_ROLE_LINES = WINDOW_ROLES.map((r) => `- ${roleLine(r)}`).join("\n");
const DISPATCH_ROLE_LINES = DISPATCH_ROLES.map((r) => `- ${roleLine(r)}`).join("\n");

const DEFAULT_BEHAVIOR_POLICY = `# 行为规则

- 默认在本会话完成所有工作，包括编码、验证、小杂务；不要主动调用 subagent、subagent_inline、handoff_open。
- 只有用户在消息中明确要求时才使用子代理或交接，例如「开子代理」「派给某个角色」「让某个角色验一下」「交接」「开新窗口」，或用户使用了 \`>>\`、\`/route new\`、\`/route handoff\`。
- 若某步适合拆出去（独立审查、测试设计、输出量大只需结论的排查、无关新任务、上下文过长），可以一句话建议，由用户决定，不要自己调用。
- task 必须自包含（子代理看不到本会话）：背景、相关文件、已定决策、具体任务、验收标准、汇报要点；不要带入无关内容。
- model 用完整的 provider/id。
- 多个新窗口子任务并行时，收到部分结果只做一句简短确认，不调用工具；等全部回来再统一编排。窗口内并行任务用一次 subagent_inline（tasks）提交，等这次调用返回后再编排。
- 用户说「在这里做 / 不用开新窗口」时，照做。
- 用户明确要求本次换一种执行方式时，照做，用另一个工具。
- 请用户在方案间做选择时，凡会引入新机制、明显增加代码量或依赖第三方内部实现的选项，附一句代价说明（「选 X 需要额外实现 Y，风险是 Z」）。
- 用户明确要求交接时，把自包含说明写到 {{handoffDir}}/<名称>-<日期时间>.md。
`;

/** 所有被分派的子代理都会注入；角色文件只需写角色特有内容。{{ask}} 按执行方式替换。 */
const DEFAULT_WORKER_POLICY = `# 子代理约定（task-router）

你是被调用方分派出来的子代理，看不到调用方会话的上下文，只依据任务提示词工作。

- 只做任务提示词范围内的事，不重新设计方案、不扩大范围。
- 提示词有歧义、方案按原样做不到、或需要越界 / 引入明显更复杂的新机制时：{{ask}}说明遇到了什么、可选做法及各自代价、推荐哪个。
- 删除、覆盖等不可逆操作只在任务明确要求的范围内进行。
- 除非任务要求，不要 git commit。
- 每个结论给出依据（命令与关键输出、文件:行号）；没验证过的标明。

## 资源安全（硬性规则）
- 只能关闭/停止自己本次创建、并记下了 ID（tab/pane/agent）的 herdr 资源；关闭前用 \`herdr tab get\`/\`pane get\` 核对 label、cwd 与 agent_session 仍是自己创建的。
- 不得关闭任何 workspace；不得关闭用户或其他会话的 tab/pane，即使看起来像测试残留。
- 删除会话文件只能按自己记录的完整文件路径逐个删除，不得删除整个 \`~/.pi/agent/sessions/\` 子目录。
- 测试目录名必须带随机后缀（如 \`mktemp -d\`），不要复用固定路径。
- 归属不确定的资源一律保留，在汇报中列出，由用户决定。

## 汇报
最后一条回复就是交回调用方的汇报，简短。角色说明另有格式时以角色为准，否则用：

\`\`\`
## 结果
## 修改的文件（没有写“无”）
## 验证情况
## 偏差（与任务不一致之处及原因，没有写“无”）
## 遗留问题 / 需要调用方决定的事
\`\`\`
`;

const WORKER_ASK = SUBAGENT_ID && !INLINE_SUBAGENT
	? "用 caller_ping 询问调用方，"
	: "停止执行，在汇报中";

function applyPolicyPlaceholders(text: string): string {
	return text.replaceAll("{{handoffDir}}", HANDOFF_DIR_PROMPT).replaceAll("{{ask}}", WORKER_ASK);
}

function ensureDefaultFile(path: string, content: string, label: string): string | undefined {
	if (existsSync(path)) return undefined;
	try {
		writeFileSync(path, content, "utf8");
		return undefined;
	} catch (e: any) {
		return `未能写入默认${label}文件 ${path}（${String(e?.message ?? e).slice(0, 120)}）`;
	}
}

function loadRuleFile(
	path: string,
	fallback: string,
	label: string,
): { text: string; source: "file" | "builtin"; warning?: string } {
	if (!existsSync(path)) return { text: fallback, source: "builtin" };
	try {
		return { text: readFileSync(path, "utf8"), source: "file" };
	} catch (e: any) {
		return {
			text: fallback,
			source: "builtin",
			warning: `读取${label}文件 ${path} 失败（${String(e?.message ?? e).slice(0, 120)}），已改用内置默认`,
		};
	}
}

const POLICY_FILE_ENSURE_WARNING = joinWarnings(
	ensureDefaultFile(DEFAULT_POLICY_PATH, DEFAULT_BEHAVIOR_POLICY, "行为规则"),
	ensureDefaultFile(WORKER_POLICY_PATH, DEFAULT_WORKER_POLICY, "子代理约定"),
);
const POLICY_LOAD = loadRuleFile(POLICY_FILE, DEFAULT_BEHAVIOR_POLICY, "行为规则");
const WORKER_POLICY_LOAD = loadRuleFile(WORKER_POLICY_PATH, DEFAULT_WORKER_POLICY, "子代理约定");
const POLICY_WARNING = joinWarnings(
	POLICY_FILE_ENSURE_WARNING,
	POLICY_LOAD.warning,
	WORKER_POLICY_LOAD.warning,
);
/** 被分派的子代理；与 spawning 无关。handoff_open 开的会话已去掉 PI_SUBAGENT_* / PI_INLINE_*，是普通会话 */
const DISPATCHED_WORKER = !!SUBAGENT_ID || INLINE_SUBAGENT;
const ROLE_PROTOCOL = DISPATCHED_WORKER ? applyPolicyPlaceholders(WORKER_POLICY_LOAD.text).trim() : "";

function blockedToolNames(): string[] {
	const names: string[] = [];
	if (!FEATURES.windowSubagent) names.push("subagent");
	if (!FEATURES.inlineSubagent) names.push("subagent_inline");
	if (!FEATURES.handoff) names.push("handoff_open");
	return names;
}

function deactivateBlockedTools(pi: ExtensionAPI, selectedTools?: string[]): void {
	const blocked = new Set(blockedToolNames());
	if (blocked.size === 0) return;
	const current =
		selectedTools ?? (typeof pi.getActiveTools === "function" ? pi.getActiveTools.call(pi) : []);
	if (!Array.isArray(current)) return;
	const next = current.filter((name) => !blocked.has(name));
	if (next.length === current.length) return;
	if (selectedTools) {
		selectedTools.length = 0;
		selectedTools.push(...next);
	}
	if (typeof pi.setActiveTools === "function") {
		try {
			pi.setActiveTools(next);
		} catch {
			// 加载期或运行时未就绪时仍靠 tool_call 拦截
		}
	}
}

function buildFacts(herdr: boolean, features: Features = FEATURES): string {
	const header = herdr
		? "本会话固定使用一个模型。可用模型："
		: "本会话固定使用一个模型。当前不在 herdr 中，无法开新窗口。可用模型：";
	const sections: string[] = [];
	const inlineOn = features.inlineSubagent;
	const windowOn = herdr && features.windowSubagent;
	const handoffOn = features.handoff;

	if (inlineOn) {
		const lines = herdr ? INLINE_ROLE_LINES : DISPATCH_ROLE_LINES;
		sections.push(
			lines
				? `窗口内同步执行（工具 subagent_inline，结果直接返回；多个窗口内子任务用 tasks 模式一次性提交）：\n${lines}`
				: "窗口内同步执行：工具 subagent_inline 可用。",
		);
	}

	if (windowOn && WINDOW_ROLE_LINES) {
		sections.push(`开新窗口异步执行（工具 subagent，结果会自动回到本会话，不要轮询或等待）：\n${WINDOW_ROLE_LINES}`);
	}

	if (handoffOn && herdr) {
		sections.push(
			`交接当前任务：把自包含说明写到 ${HANDOFF_DIR_PROMPT}/<名称>-<日期时间>.md（目标、当前进度、关键决定、相关文件、未完成步骤、注意事项，以及「第一步」），再调用 handoff_open（file；省略 model、thinking 即沿用当前模型和思考等级，用户指定了模型时才传）。新窗口是普通会话，结果不回传。\n- 与主题无关的新任务同样用这种方式在新窗口开普通会话：说明里写任务本身（背景、目标、相关文件、验收标准、「第一步」），model 和 thinking 按任务难度选。`,
		);
	} else if (handoffOn) {
		sections.push(
			`交接或开始无关新任务：把自包含说明写到 ${HANDOFF_DIR_PROMPT}/<名称>-<日期时间>.md。当前不在 herdr 中，handoff_open 不可用；把提示词交给用户在新会话中继续。`,
		);
	} else if (!herdr) {
		sections.push("需要全新会话时，写一份自包含提示词交给用户，建议用户在新会话中执行。");
	}

	const tools = sections.length ? `当前可用的工具与角色：\n${sections.join("\n")}` : "当前未启用子代理分派或交接。";
	return `# 任务分派（task-router）\n${header}\n${modelTable}\n\n${tools}`;
}

function buildPolicy(herdr: boolean, behavior: string = POLICY_LOAD.text, features: Features = FEATURES): string {
	const facts = buildFacts(herdr, features);
	const rules = applyPolicyPlaceholders(behavior).trim();
	const extra = POLICY_APPEND ? `\n${POLICY_APPEND}` : "";
	return `\n${facts}${rules ? `\n\n${rules}` : ""}${extra}`;
}

const POLICY_HERDR = buildPolicy(true);
const POLICY_PLAIN = buildPolicy(false);

type DispatchJob = { agent: string; task: string; model?: string; thinking?: string; name?: string };

function dispatchJobs(input: any): DispatchJob[] {
	if (!input || typeof input !== "object") return [];
	const topModel = typeof input.model === "string" ? input.model : undefined;
	const topThinking = typeof input.thinking === "string" ? input.thinking : undefined;
	const fromList = (list: any[]): DispatchJob[] =>
		list.map((t) => ({
			agent: String(t?.agent ?? ""),
			task: String(t?.task ?? ""),
			model: typeof t?.model === "string" ? t.model : topModel,
			thinking: typeof t?.thinking === "string" ? t.thinking : topThinking,
		}));
	if (Array.isArray(input.tasks) && input.tasks.length > 0) return fromList(input.tasks);
	return [
		{
			agent: String(input.agent ?? ""),
			task: String(input.task ?? ""),
			model: topModel,
			thinking: topThinking,
			name: typeof input.name === "string" ? input.name : undefined,
		},
	];
}

function applyModelThinking(input: any, model?: string, thinking?: string): void {
	if (model) {
		input.model = model;
		if (Array.isArray(input.tasks)) for (const t of input.tasks) t.model = model;
	}
	if (thinking) {
		input.thinking = thinking;
		if (Array.isArray(input.tasks)) for (const t of input.tasks) t.thinking = thinking;
	}
}

function setSingleTask(input: any, task: string): void {
	if (Array.isArray(input.tasks) && input.tasks.length === 1) input.tasks[0].task = task;
	else input.task = task;
}

// ───────────────────────── 扩展 ─────────────────────────

const SUBAGENT_RUNTIME_KEY = Symbol.for("pi-subagents/runtime");

/** 本进程 runningSubagents（父会话自己派生的子窗口）。读不到当 0。 */
function countRunningSubagents(): number {
	const map = (globalThis as Record<symbol, any>)[SUBAGENT_RUNTIME_KEY]?.runningSubagents;
	return map instanceof Map ? map.size : 0;
}

function herdrJson(args: string[], timeoutMs = 45_000): any {
	try {
		return JSON.parse(execFileSync("herdr", args, { encoding: "utf8", timeout: timeoutMs }));
	} catch (e: any) {
		throw new Error(`herdr ${args.slice(0, 3).join(" ")} 失败：${String(e?.stderr || e?.message || e).slice(0, 300)}`);
	}
}

function toPromptPath(p: string): string {
	return p.replaceAll("\\", "/");
}

/** Git Bash / MSYS / Cygwin / WSL 盘符路径 → 原生 Windows 路径。`//` UNC 不转。 */
function normalizeWindowsShellPath(filePath: string): string {
	if (!filePath.startsWith("/") || filePath.startsWith("//") || filePath.includes("\\")) return filePath;
	const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
	if (!match) return filePath;
	const suffix = match[2]?.replaceAll("/", "\\");
	return `${match[1].toUpperCase()}:\\${suffix ?? ""}`;
}

function expandHandoffTilde(filePath: string): string {
	return expandUserPath(filePath);
}

function isPathInsideDir(root: string, file: string): boolean {
	const norm = (p: string) => {
		const s = p.replaceAll("\\", "/");
		return IS_WIN32 ? s.toLowerCase() : s;
	};
	const r = norm(root);
	const f = norm(file);
	const prefix = r.endsWith("/") ? r : `${r}/`;
	return f.startsWith(prefix) && f.length > prefix.length;
}

function resolveHandoffFile(file: string): string {
	let input = file.trim();
	if (IS_WIN32) input = normalizeWindowsShellPath(input);
	input = expandHandoffTilde(input);
	const noSep = !input.includes("/") && !input.includes("\\");
	const resolved = resolve(noSep ? join(HANDOFF_DIR, basename(input)) : input);
	const root = resolve(HANDOFF_DIR);
	if (!isPathInsideDir(root, resolved)) throw new Error(`交接文件必须在 ${HANDOFF_DIR_PROMPT} 下`);
	if (!existsSync(resolved) || !statSync(resolved).isFile()) throw new Error(`交接文件不存在：${toPromptPath(resolved)}`);
	return resolved;
}

function assertHandoffArg(value: string, label: string): void {
	if (/[\r\n"&|<>^%]/.test(value)) throw new Error(`${label} 含非法字符`);
}

function paneHasAgent(paneId: string): boolean {
	const agents = herdrJson(["agent", "list"])?.result?.agents;
	return Array.isArray(agents) && agents.some((a: any) => a?.pane_id === paneId);
}

function waitForPaneAgent(paneId: string, timeoutMs: number): void {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (paneHasAgent(paneId)) return;
		sleepSync(500);
	}
	throw new Error(`等待 pane ${paneId} 上的 agent 超时`);
}

/** Windows pane 多为 PowerShell；herdr `agent start --kind pi` 会 Start-Process 无扩展的 npm `pi` 脚本。 */
function startHandoffPi(paneId: string, agent: string, model: string, thinking: string): void {
	assertHandoffArg(model, "model");
	assertHandoffArg(thinking, "thinking");
	if (IS_WIN32) {
		const cmd = [
			"Get-ChildItem Env: | Where-Object { $_.Name -like 'PI_SUBAGENT_*' -or $_.Name -like 'PI_INLINE_*' } | ForEach-Object { Remove-Item -LiteralPath ('Env:' + $_.Name) }",
			`pi.cmd --model ${model} --thinking ${thinking}`,
		].join("; ");
		sleepSync(1500);
		execFileSync("herdr", ["pane", "run", paneId, cmd], { encoding: "utf8", timeout: 10_000 });
		waitForPaneAgent(paneId, 60_000);
		try {
			herdrJson(["agent", "rename", paneId, agent]);
		} catch {}
		return;
	}
	execFileSync(
		"herdr",
		["pane", "run", paneId, 'for __v in $(env | awk -F= \'/^(PI_SUBAGENT_|PI_INLINE_)/{print $1}\'); do unset "$__v"; done'],
		{ encoding: "utf8", timeout: 10_000 },
	);
	sleepSync(400);
	herdrJson(["agent", "start", agent, "--kind", "pi", "--pane", paneId, "--timeout", "60000", "--", "--model", model, "--thinking", thinking], 70_000);
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 去掉末尾一次 ` handoff[数字]`。纯 `handoff[数字]`（无基名）视为无原窗口名。 */
function stripHandoffSuffix(label: string): string {
	if (/^handoff\[\d+\]$/.test(label)) return "";
	const m = label.match(/^(.*) handoff\[(\d+)\]$/);
	return m ? m[1] : label;
}

function nextHandoffIndex(labels: unknown[], base: string | undefined): number {
	const re = base ? new RegExp(`^${escapeRegExp(base)} handoff\\[(\\d+)\\]$`) : /^handoff\[(\d+)\]$/;
	let max = 0;
	for (const label of labels) {
		if (typeof label !== "string") continue;
		const m = label.match(re);
		if (!m) continue;
		const n = Number(m[1]);
		if (Number.isInteger(n) && n > max) max = n;
	}
	return max + 1;
}

function nextHandoffTabLabel(): string {
	try {
		const ws = process.env.HERDR_WORKSPACE_ID;
		if (!ws) return "handoff[1]";

		let base: string | undefined;
		const tabId = process.env.HERDR_TAB_ID;
		if (tabId) {
			try {
				const got = herdrJson(["tab", "get", tabId]);
				const label = got?.result?.tab?.label;
				if (typeof label === "string" && label.length > 0) {
					const stripped = stripHandoffSuffix(label);
					if (stripped) base = stripped;
				}
			} catch {
				// 取不到原窗口名：基名缺失，仍按 workspace 编号
			}
		}

		let labels: unknown[] = [];
		try {
			const listed = herdrJson(["tab", "list", "--workspace", ws]);
			const tabs = listed?.result?.tabs;
			if (Array.isArray(tabs)) labels = tabs.map((t: any) => t?.label);
		} catch {
			return "handoff[1]";
		}
		const n = nextHandoffIndex(labels, base);
		return base ? `${base} handoff[${n}]` : `handoff[${n}]`;
	} catch {
		return "handoff[1]";
	}
}

function openHandoffSession(file: string, model: string, thinking: string, cwd: string): { tabId: string; paneId: string; agent: string } {
	const ws = process.env.HERDR_WORKSPACE_ID;
	if (!ws) throw new Error("找不到 HERDR_WORKSPACE_ID");
	const filePrompt = toPromptPath(file);
	const created = herdrJson(["tab", "create", "--workspace", ws, "--cwd", cwd, "--label", nextHandoffTabLabel(), "--focus"]);
	const tabId = created?.result?.tab?.tab_id;
	const paneId = created?.result?.root_pane?.pane_id;
	if (typeof tabId !== "string" || typeof paneId !== "string") throw new Error("herdr tab create 未返回 tab/pane id");
	const agent = `ho${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.slice(0, 32);
	try {
		startHandoffPi(paneId, agent, model, thinking);
	} catch (e) {
		try {
			execFileSync("herdr", ["tab", "close", tabId], { encoding: "utf8", timeout: 10_000 });
		} catch {}
		throw e;
	}
	try {
		try {
			herdrJson(["agent", "prompt", agent, `读取交接文件 ${filePrompt} 并按其中「第一步」开始。`]);
		} catch {
			herdrJson(["agent", "prompt", paneId, `读取交接文件 ${filePrompt} 并按其中「第一步」开始。`]);
		}
	} catch (e: any) {
		throw new Error(`新会话已启动（tab ${tabId}，pane ${paneId}），但发送交接指令失败，请在该窗口手动让它读取 ${filePrompt}：${e?.message ?? e}`);
	}
	return { tabId, paneId, agent };
}

/** 等本进程真正退出后再关当前 pane。各平台统一用 node -e，逻辑与原先 sh 相同：kill(pid,0) 最多 60 秒，再 herdr pane get/close，失败写入 CLOSE_LOG_PATH。 */
const CLOSE_PANE_JS = [
	'const { execFileSync } = require("node:child_process");',
	'const { appendFileSync } = require("node:fs");',
	'const args = process.argv.slice(1).filter((a) => a !== "-e" && a !== "--");',
	'const pid = Number(args[0]);',
	'const paneId = args[1];',
	'const logPath = args[2];',
	'if (!Number.isFinite(pid) || !paneId || !logPath) process.exit(0);',
	'function stamp() {',
	'\tconst d = new Date();',
	'\tconst p = (n) => String(n).padStart(2, "0");',
	'\treturn d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());',
	'}',
	'function log(msg) { try { appendFileSync(logPath, stamp() + " " + msg + "\\n"); } catch {} }',
	'function appendErr(e) {',
	'\tconst err = e && e.stderr != null ? String(e.stderr) : "";',
	'\tif (err) { try { appendFileSync(logPath, err.endsWith("\\n") ? err : err + "\\n"); } catch {} }',
	'}',
	'function alive() { try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === "EPERM"); } }',
	'for (let i = 0; i < 600 && alive(); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);',
	'if (alive()) { log("timeout 60s waiting for pid " + pid + ", skip close pane " + paneId); process.exit(0); }',
	'try { execFileSync("herdr", ["pane", "get", paneId], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "ignore", "pipe"] }); }',
	'catch (e) { appendErr(e); log("pane " + paneId + " gone or unreadable, skip close"); process.exit(0); }',
	'try { execFileSync("herdr", ["pane", "close", paneId], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "ignore", "pipe"] }); }',
	'catch (e) { appendErr(e); log("herdr pane close failed for pane " + paneId); }',
].join("\n");

function closeCurrentHerdrPaneAfterExit(): void {
	const paneId = process.env.HERDR_PANE_ID;
	if (!paneId) return;
	const child = spawn(
		process.execPath,
		["-e", CLOSE_PANE_JS, "--", String(process.pid), paneId, CLOSE_LOG_PATH],
		{ detached: true, stdio: "ignore", windowsHide: true },
	);
	child.unref();
}

function createSerialQueue(): <T>(fn: () => Promise<T>) => Promise<T> {
	let tail: Promise<unknown> = Promise.resolve();
	return (fn) => {
		const run = tail.then(fn, fn);
		tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};
}

function matchingPick(provider?: string, id?: string): Pick | undefined {
	if (!provider || !id) return undefined;
	return (Object.keys(MODELS) as Pick[]).find((k) => MODELS[k].provider === provider && MODELS[k].id === id);
}

function nextContextWarn(
	sid: string,
	usage: { tokens?: number; percent?: number } | undefined,
	userTurns: number,
	warned: Set<string>,
): { key: string; reason: string } | undefined {
	for (const t of CONTEXT_WARN_TOKENS) {
		const key = `${sid}:t${t}`;
		if ((usage?.tokens ?? 0) >= t && !warned.has(key)) {
			return { key, reason: `上下文约 ${Math.round((usage!.tokens ?? 0) / 1000)}k tokens` };
		}
	}
	const percentKey = `${sid}:p`;
	if ((usage?.percent ?? 0) >= CONTEXT_WARN_PERCENT && !warned.has(percentKey)) {
		return { key: percentKey, reason: `上下文已用 ${Math.round(usage!.percent!)}%` };
	}
	const turnsKey = `${sid}:u`;
	if (userTurns >= USER_TURN_WARN && !warned.has(turnsKey)) {
		return { key: turnsKey, reason: `本会话已 ${userTurns} 轮` };
	}
	return undefined;
}

export {
	createSerialQueue,
	countRunningSubagents,
	matchingPick,
	nextContextWarn,
	isPiVersionBelow,
	parsePiVersion,
	MIN_PI_VERSION,
	buildPolicy,
	buildFacts,
	applyPolicyPlaceholders,
	DEFAULT_BEHAVIOR_POLICY,
	validateConfig,
};

export default function (pi: ExtensionAPI) {
	let confirmOn = FEATURES.confirm;
	/** /route handoff 本轮：handoff_open 成功后，在 agent_settled 询问是否关闭本窗口 */
	let handoffPending = false;
	let handoffOpened = false;
	const enqueueDispatchConfirm = createSerialQueue();

	if (IN_HERDR && FEATURES.handoff) {
		pi.registerTool({
			name: "handoff_open",
			label: "交接开窗",
			description:
				`读取 ${HANDOFF_DIR_PROMPT}/ 下已写好的交接文件，在当前 workspace 新开 tab 启动普通 pi 会话（去掉 PI_SUBAGENT_* / PI_INLINE_*，不受子代理监视、不回传）。参数：file；model（provider/id）、thinking 可省略，省略时沿用当前会话的模型和思考等级。`,
			promptSnippet: `把交接说明写到 ${HANDOFF_DIR_PROMPT}/<名称>-<日期时间>.md 后调用，开新 tab 接手。`,
			parameters: Type.Object({
				file: Type.String({ description: `交接文件路径，必须在 ${HANDOFF_DIR_PROMPT}/ 下` }),
				model: Type.Optional(Type.String({ description: "新会话模型，provider/id；省略则沿用当前模型" })),
				thinking: Type.Optional(Type.String({ description: "思考等级，如 low|medium|high；省略则沿用当前思考等级" })),
			}),
			executionMode: "sequential",
			async execute(_id, params, _signal, _onUpdate, ctx) {
				if (IS_WORKER) throw new Error("当前角色不允许交接");
				const file = resolveHandoffFile(params.file);
				const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
				const model = params.model?.trim() || current;
				const thinking = params.thinking?.trim() || ctx.thinkingLevel || pi.getThinkingLevel() || "medium";
				if (!model) throw new Error("当前会话没有模型，需要显式传 model");
				const opened = openHandoffSession(file, model, thinking, ctx.cwd);
				return {
					content: [{ type: "text", text: `已在新 tab 启动会话（${opened.tabId} / ${opened.agent}）。这是普通会话，结果不会回传。` }],
					details: opened,
				};
			},
		});
	}

	pi.on("session_start", (_event, ctx) => {
		ensureThinkingOn(pi, ctx);
		deactivateBlockedTools(pi);
		if (CONFIG_WARNING) {
			if (ctx.hasUI) ctx.ui.notify(CONFIG_WARNING, ROUTING_PAUSED ? "error" : "warning");
			else if (ROUTING_PAUSED) console.error(`[task-router] ${CONFIG_WARNING}`);
		}
		if (POLICY_WARNING) {
			if (ctx.hasUI) ctx.ui.notify(POLICY_WARNING, "warning");
			else console.error(`[task-router] ${POLICY_WARNING}`);
		}
		const runtimeWarnings = collectRuntimeWarnings(pi);
		if (runtimeWarnings.length === 0) return;
		const msg = runtimeWarnings.join("\n");
		if (ctx.hasUI) ctx.ui.notify(msg, "warning");
		else console.error(`[task-router] ${msg}`);
	});

	pi.on("model_select", (_event, ctx) => {
		ensureThinkingOn(pi, ctx);
	});

	const warned = new Set<string>();

	function defaultDispatchMode(): DispatchMode | undefined {
		if (IN_HERDR && FEATURES.handoff) return "handoff";
		if (FEATURES.inlineSubagent) return "inline";
		return undefined;
	}

	function dispatchText(kind: string, original: string, suggestion?: string, mode?: DispatchMode): string {
		const resolved = mode ?? defaultDispatchMode() ?? "inline";
		const sug = suggestion ? `路由建议模型：${suggestion}；可根据上下文调整。` : "";
		const how =
			resolved === "handoff"
				? `写到 ${HANDOFF_DIR_PROMPT}/<名称>-<日期时间>.md（背景、目标、相关文件、验收标准、「第一步」），再调用 handoff_open（file、model、thinking，model 和 thinking 按任务难度选）。新窗口是普通会话，结果不回传。${sug}`
				: `调用 subagent_inline 在窗口内同步执行（${(IN_HERDR ? INLINE_ROLES : DISPATCH_ROLES).join(" / ") || DISPATCH_ROLES.join(" / ") || "（无）"}）。${sug}`;
		return `[task-router] 用户提出了下面这个应分派出去的${kind}。不要在本会话中执行它。结合当前会话上下文写一份自包含的任务提示词，${how}\n\n用户原话：\n${original}`;
	}

	// 系统提示注入（自动执行的子窗口由角色定义负责，不注入）
	pi.on("before_agent_start", (event) => {
		// 子代理约定与路由开关无关，始终注入
		const protocol = ROLE_PROTOCOL ? `\n${ROLE_PROTOCOL}\n` : "";
		if (IS_WORKER || ROUTING_PAUSED) return protocol ? { systemPrompt: event.systemPrompt + protocol } : undefined;
		const opts = (event as { systemPromptOptions?: { selectedTools?: string[] } }).systemPromptOptions;
		if (opts && Array.isArray(opts.selectedTools)) deactivateBlockedTools(pi, opts.selectedTools);
		else deactivateBlockedTools(pi);
		return { systemPrompt: event.systemPrompt + protocol + "\n" + (IN_HERDR ? POLICY_HERDR : POLICY_PLAIN) };
	});

	// 输入拦截
	pi.on("input", async (event, ctx) => {
		if (IS_WORKER || event.source !== "interactive" || event.streamingBehavior) return { action: "continue" };
		let text = event.text.trim();
		if (!text || text.startsWith("/") || text.startsWith("!")) return { action: "continue" };
		// Read-only catalog queries are handled by the proxy audit extension, not task routing.
		if (/^(?:请)?(?:帮我)?(?:更新中转站|查询模型|查询中转站模型)[。！!？?\s]*$/.test(text)) return { action: "continue" };

		const msgs = branchMessages(ctx);
		const hasUser = msgs.some((m) => m.role === "user");

		if (text.startsWith(">>")) {
			const task = text.slice(2).trim();
			const mode = defaultDispatchMode();
			if (!mode) {
				if (ctx.hasUI) ctx.ui.notify("交接与窗口内子代理均已关闭，已在本会话处理", "warning");
				return task ? { action: "transform", text: task } : { action: "handled" };
			}
			return { action: "transform", text: dispatchText("新任务", task, undefined, mode) };
		}

		// 首条消息：@代号 手动指定模型
		if (!hasUser) {
			if (SUBAGENT_ID || INLINE_SUBAGENT || EXPLICIT_MODEL) return { action: "continue" };
			const modelChanges = ctx.sessionManager.getBranch().filter((e: any) => e.type === "model_change").length;
			if (modelChanges > 1) return { action: "continue" };

			const info = parseModelPrefix(text);
			if (!info) return { action: "continue" };
			text = text.replace(PREFIX_RE, "").trimStart();
			const p: Pick = info.model;
			const lv = asLevel(info.thinking);
			const ok = await applyModel(pi, ctx, p, lv);
			const label = `${MODELS[p].id} • ${lv}`;
			ctx.ui.notify(
				ok
					? `⇢ 本会话模型：${label} ｜ ${info.reason}`
					: `⚠ 切换到 ${label} 失败（无凭据？），保持当前模型`,
				ok ? "info" : "warning",
			);
			const recordedPick = ok ? p : matchingPick(ctx.model?.provider, ctx.model?.id);
			const recordedThinking = ok ? lv : asLevel(ctx.thinkingLevel);
			pi.appendEntry("task-router", {
				model: recordedPick,
				thinking: recordedThinking,
				topic: text.slice(0, 500),
				reason: info.reason,
			});
			return { action: "transform", text };
		}

		return { action: "continue" };
	});

	function jobRuntime(job: DispatchJob, ctx: ExtensionContext): { model: string; thinking: string } {
		return {
			model: job.model ?? agentDefault(job.agent, "model") ?? `继承 ${ctx.model?.provider}/${ctx.model?.id}`,
			thinking: job.thinking ?? agentDefault(job.agent, "thinking") ?? "继承",
		};
	}

	function confirmTitle(toolName: string, input: any, jobs: DispatchJob[], ctx: ExtensionContext): string {
		const place = toolName === "subagent_inline" ? "窗口内执行" : "新窗口执行";
		if (jobs.length <= 1) {
			const job = jobs[0] ?? { agent: "", task: "" };
			const { model, thinking } = jobRuntime(job, ctx);
			const name = job.name ?? input.name;
			return `⇢ ${place}${name ? `「${name}」` : ""} 角色：${job.agent || "（无）"}${input.fork ? " · fork" : ""}\n   模型：${model} • ${thinking} ｜ 任务 ${String(job.task ?? "").length} 字`;
		}
		const mode = "并行";
		const lines = jobs.map((job, i) => {
			const { model, thinking } = jobRuntime(job, ctx);
			return `   ${i + 1}. 角色：${job.agent || "（无）"} ｜ ${model} • ${thinking} ｜ 任务 ${String(job.task ?? "").length} 字`;
		});
		return `⇢ ${place} ${mode} ${jobs.length} 项\n${lines.join("\n")}`;
	}

	/** 只用 ctx.ui.select 自带 timeout（含倒计时）。Esc 与超时都返回 undefined，用耗时区分：计时起点早于对话框内部计时器，超时必然 >= timeoutMs；留 20ms 容差防计时器提前触发；代价是超时前 20ms 内的 Esc 会被当成超时执行（原为 500ms）。 */
	async function selectChoice(
		ctx: ExtensionContext,
		title: string,
		options: string[],
		timeoutMs: number | undefined,
	): Promise<{ choice: string | undefined; timedOut: boolean }> {
		if (!timeoutMs || timeoutMs <= 0) {
			return { choice: await ctx.ui.select(title, options), timedOut: false };
		}
		const started = Date.now();
		const choice = await ctx.ui.select(title, options, { timeout: timeoutMs });
		if (choice !== undefined) return { choice, timedOut: false };
		return { choice: undefined, timedOut: Date.now() - started >= timeoutMs - 20 };
	}

	// 拦截 subagent / subagent_inline：确认 / 编辑 / 换模型 / 取消
	pi.on("tool_call", async (event, ctx) => {
		if (WORKER_DENY_SPAWN && SPAWN_TOOL_NAMES.has(event.toolName)) {
			return {
				block: true,
				reason:
					"当前角色不允许继续分派。不要调用 subagent、subagent_inline、subagent_interrupt、subagent_resume、subagents_list、handoff_open，直接完成任务。",
			};
		}
		if (event.toolName === "subagent" && !FEATURES.windowSubagent) {
			return {
				block: true,
				reason: "开新窗口分派已关闭（features.windowSubagent=false）。不要调用 subagent。",
			};
		}
		if (event.toolName === "subagent_inline" && !FEATURES.inlineSubagent) {
			return {
				block: true,
				reason: "窗口内子代理已关闭（features.inlineSubagent=false）。不要调用 subagent_inline。",
			};
		}
		if (event.toolName === "handoff_open" && !FEATURES.handoff) {
			return {
				block: true,
				reason: "交接已关闭（features.handoff=false）。不要调用 handoff_open。",
			};
		}
		const isInline = event.toolName === "subagent_inline";
		const isWindow = event.toolName === "subagent";
		if (!isInline && !isWindow) return;
		const input = event.input as any;
		const jobs = dispatchJobs(input);
		if (IS_WORKER || !confirmOn || !ctx.hasUI) return;

		const confirmTimeoutSec = isInline ? INLINE_CONFIRM_TIMEOUT_SEC : CONFIRM_TIMEOUT_SEC;
		return enqueueDispatchConfirm(async () => {
			let interacted = false;
			for (;;) {
				const timeoutMs = !interacted && confirmTimeoutSec > 0 ? confirmTimeoutSec * 1000 : undefined;
				const options = [
					"执行",
					...(jobs.length === 1 ? ["查看或编辑任务"] : []),
					...(PICKS.length > 0 ? [jobs.length > 1 ? "全部使用同一模型" : "换模型"] : []),
					"取消",
				];
				const { choice, timedOut } = await selectChoice(
					ctx,
					confirmTitle(event.toolName, input, jobs, ctx),
					options,
					timeoutMs,
				);
				if (choice === "查看或编辑任务") {
					interacted = true;
					const edited = await ctx.ui.editor("编辑任务提示词", jobs[0]?.task ?? "");
					if (edited !== undefined) {
						setSingleTask(input, edited);
						if (jobs[0]) jobs[0].task = edited;
					}
					continue;
				}
				if (choice === "换模型" || choice === "全部使用同一模型") {
					interacted = true;
					const m = await ctx.ui.select("选择模型", PICKS.map((k) => `${k} — ${ref(k)}`));
					const model = m ? ref(m.split(" ")[0]) : undefined;
					const l = await ctx.ui.select("思考等级", ["low", "medium", "high"]);
					applyModelThinking(input, model, l ?? undefined);
					for (const job of jobs) {
						if (model) job.model = model;
						if (l) job.thinking = l;
					}
					continue;
				}
				if (choice === "执行") return;
				if (choice === undefined && timedOut) {
					ctx.ui.notify(isInline ? "未在限时内选择，已按默认在窗口内执行" : "未在限时内选择，已按默认开新窗口执行", "info");
					return;
				}
				return { block: true, reason: "用户取消了这次分派。不要重试，询问用户希望如何处理。" };
			}
		});
	});

	pi.on("tool_result", (event) => {
		if (handoffPending && event.toolName === "handoff_open" && !event.isError) handoffOpened = true;
	});

	// 上下文过长提醒 + 任意模型出错切 fallback（fallback 自身出错不弹）
	pi.on("agent_settled", async (event, ctx) => {
		const opened = handoffOpened;
		handoffPending = false;
		handoffOpened = false;
		if (!event.aborted && IN_HERDR && ctx.hasUI && opened) {
			if (!FEATURES.handoffAutoClose) return;
			const choice = await ctx.ui.select("交接完成，关闭本窗口？", ["是", "否"]);
			if (choice === "是") {
				closeCurrentHerdrPaneAfterExit();
				ctx.shutdown();
			}
			return;
		}
		if (event.aborted || !ctx.hasUI || IS_WORKER) return;
		const msgs = branchMessages(ctx);
		const last = [...msgs].reverse().find((m) => m.role === "assistant");
		const fallbackSpec = MODELS[FALLBACK];

		if (last?.stopReason === "error" && fallbackSpec) {
			const isFallback = last.provider === fallbackSpec.provider && last.model === fallbackSpec.id;
			if (!isFallback) {
				const c = await ctx.ui.select(`⚠ ${last.model} 请求失败：${(last.errorMessage ?? "").slice(0, 120)}`, [
					`切换到 ${fallbackSpec.id} 继续本会话`,
					"稍后手动重试",
				]);
				if (c?.startsWith("切换")) {
					const switched = await applyModel(pi, ctx, FALLBACK, asLevel(ctx.thinkingLevel));
					ctx.ui.notify(
						switched
							? `已切换到 ${fallbackSpec.id}，发送"继续"即可`
							: `⚠ 切换到 ${fallbackSpec.id} 失败（无凭据？），保持当前模型`,
						switched ? "info" : "warning",
					);
				}
				return;
			}
		}

		if (!FEATURES.contextWarn) return;
		const usage = ctx.getContextUsage();
		const sid = ctx.sessionManager.getSessionId?.() ?? "s";
		const userTurns = msgs.filter((m) => m.role === "user").length;
		const warn = nextContextWarn(sid, usage, userTurns, warned);
		if (warn && countRunningSubagents() === 0) {
			warned.add(warn.key);
			ctx.ui.notify(`💡 ${warn.reason}。如果无关或过时内容较多，可以用 /route handoff 让当前 agent 写交接提示词，在新窗口接手`, "warning");
		}
	});

	// /route 命令
	pi.registerCommand("route", {
		description: "task-router：status | handoff [说明] | new <任务> | confirm on|off",
		handler: async (args, ctx) => {
			const [sub, ...rest] = args.trim().split(/\s+/);
			const extra = rest.join(" ");
			const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "当前模型";
			switch (sub || "status") {
				case "handoff":
					if (!FEATURES.handoff) return ctx.ui.notify("交接已关闭（features.handoff=false）", "warning");
					if (IN_HERDR && ctx.hasUI) {
						const n = countRunningSubagents();
						if (n > 0) {
							const choice = await ctx.ui.select(`还有 ${n} 个子任务未完成`, ["等待（取消本次交接）", "强制交接"]);
							if (choice !== "强制交接") {
								ctx.ui.notify(choice === undefined ? "已取消交接" : "已取消本次交接，等待子任务完成", "info");
								return;
							}
						}
					}
					if (IN_HERDR) {
						handoffPending = true;
						handoffOpened = false;
					}
					pi.sendUserMessage(
						`[task-router] 把当前任务交接到新窗口。写一份自包含的交接说明到 ${HANDOFF_DIR_PROMPT}/<名称>-<日期时间>.md：目标、当前进度、关键决定、相关文件、未完成步骤、注意事项，以及「第一步」（告诉新会话先做什么）；丢弃已过时或无关的内容。${
							IN_HERDR
								? `然后调用 handoff_open（file: 该文件路径；不传 model、thinking，沿用当前模型 ${current} 和思考等级${extra ? "，除非用户补充里指定了模型" : ""}）。`
								: "然后把提示词完整输出给用户，建议用户在新会话中继续。"
						}${extra ? `\n用户补充：${extra}` : ""}`,
					);
					return;
				case "new": {
					if (!extra) return ctx.ui.notify("用法：/route new <任务>", "warning");
					const mode = defaultDispatchMode();
					if (!mode) return ctx.ui.notify("交接与窗口内子代理均已关闭，/route new 不可用", "warning");
					pi.sendUserMessage(dispatchText("新任务", extra, undefined, mode));
					return;
				}
				case "confirm":
					confirmOn = rest[0] !== "off";
					return ctx.ui.notify(`分派前确认：${confirmOn ? "开" : "关"}`, "info");
				default: {
					const r = routerEntry(ctx);
					const u = ctx.getContextUsage();
					const rolePlace = (name: string) => {
						const inline = !IN_HERDR || INLINE_ROLE_SET.has(name);
						if (inline) return FEATURES.inlineSubagent ? "窗口内" : "窗口内（已关）";
						return FEATURES.windowSubagent ? "新窗口" : "新窗口（已关）";
					};
					const roleLines =
						DISPATCH_ROLES.length === 0
							? ["角色：（无）"]
							: DISPATCH_ROLES.map((name) => `角色：${name}（${rolePlace(name)}）`);
					const featureLine = `功能：${FEATURE_KEYS.map((k) => `${k} ${FEATURES[k] ? "开" : "关"}`).join(" ｜ ")}`;
					ctx.ui.notify(
						[
							`模型：${current} • ${ctx.thinkingLevel ?? "?"}${r ? `（${r.reason}）` : ""}`,
							r
								? `主题：${String(r.topic).slice(0, 80)}`
								: SUBAGENT_ID
									? `子窗口角色：${SUBAGENT_ROLE || "（无）"}`
									: INLINE_SUBAGENT
										? `窗口内子代理：${INLINE_AGENT || "（无）"}`
										: "",
							`上下文：${u?.tokens ?? "?"} tokens（${u?.percent != null ? Math.round(u.percent) : "?"}%）`,
							`配置：${ROUTING_PAUSED ? "已暂停（读取/校验失败）" : CONFIG_PATH}`,
							`分派确认：${confirmOn ? "开" : "关"} ｜ herdr：${IN_HERDR ? "是" : "否"}`,
							piVersionStatusLine(),
							IN_HERDR
								? `subagent 工具：${hasSubagentTool(pi) ? "有" : "无（开新窗口分派不可用）"}`
								: "",
							IN_HERDR && IS_WIN32
								? `bash：${WIN_BASH_ON_PATH ? "PATH 中有" : "PATH 中无（开新窗口需要 Git Bash 的 bin）"}`
								: "",
							`确认超时：${CONFIRM_TIMEOUT_SEC === 0 ? "关" : `${CONFIRM_TIMEOUT_SEC} 秒`} ｜ 窗口内确认超时：${INLINE_CONFIRM_TIMEOUT_SEC === 0 ? "关" : `${INLINE_CONFIRM_TIMEOUT_SEC} 秒`}`,
							...roleLines,
							featureLine,
							`行为规则：${POLICY_LOAD.source === "file" ? `文件 ${POLICY_FILE}` : `内置默认（${POLICY_FILE}）`}`,
							`子代理约定：${WORKER_POLICY_LOAD.source === "file" ? `文件 ${WORKER_POLICY_PATH}` : "内置默认"}`,
							`policyAppend：${POLICY_APPEND ? `已设置（${POLICY_APPEND.length} 字）` : "未设置"}`,
							POLICY_WARNING ? `规则警告：${POLICY_WARNING}` : "",
							CONFIG_WARNING ? `配置警告：${CONFIG_WARNING}` : "",
						]
							.filter(Boolean)
							.join("\n"),
						"info",
					);
				}
			}
		},
	});
}
