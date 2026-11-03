/**
 * task-router — 会话级模型选择 + 分派策略（执行层由 pi-herdr-subagents 负责）
 *
 * - 配置：只读 pi 配置目录（getAgentDir()）下的 task-router.json；读取或校验失败时暂停自动路由（不注入分派策略、不自动选模型/分流），session_start 提示错误
 * - 会话首条消息：判断任务 → 选模型，本会话固定（启动时带 --model、子代理窗口、手动 /model 过的会话不判断）
 * - 分析模型见配置 analyzer（type classifier|chat；不可用时改用当前模型）
 * - 后续消息：判断是否为子任务/独立任务 → 交给当前 agent 写提示词并调用 subagent 分派
 * - 拦截 subagent / subagent_inline：确认 / 编辑任务 / 换模型 / 取消（超时自动执行，0 关闭）
 * - auto-exit 与 interactive 只对新窗口执行（subagent）生效；窗口内执行不读这两项
 * - 上下文过长：提醒 /route handoff 交接
 * - 当前模型请求失败（stopReason 为 error）且不是 fallback 本身：提供切换到 fallback
 * - /route [status|handoff|new|off|on|confirm on|confirm off]（status 含确认超时秒数）
 * - 前缀：@代号 指定首条消息模型（代号见配置 models）；>> 强制当作新窗口任务
 *
 * 角色定义：只从 pi 配置目录（getAgentDir()）下的 agents/*.md 读取（除 session 与 dispatch: false 外均可分派）
 * features：autoModel / relationCheck / confirm / contextWarn / handoffAutoClose（默认全开）
 * policyAppend：追加到分派规则末尾（不覆盖）
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { Type } from "typebox";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

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
// roles：{ "<name>": { use?, hint? } }；缺省用角色 description / frontmatter model
// features：autoModel / relationCheck / confirm / contextWarn / handoffAutoClose
// policyAppend：追加到分派规则末尾（不覆盖）

type Pick = string;
type Level = "low" | "medium" | "high";
type Analyzer = { type: "classifier" | "chat"; provider: string; id: string; timeoutMs: number };
type ModelSpec = { provider: string; id: string; desc: string };
type RoleMeta = { use?: string; hint?: string };
type FeatureKey = "autoModel" | "relationCheck" | "confirm" | "contextWarn" | "handoffAutoClose";
type Features = Record<FeatureKey, boolean>;
interface RouterConfig {
	models: Record<string, ModelSpec>;
	default: string;
	fallback: string;
	analyzer: Analyzer;
	relationMinProb: number;
	contextWarn: { tokens: number[]; percent: number; userTurns: number };
	roles: Record<string, RoleMeta>;
	/** 分派确认框首次弹出后的自动执行秒数；0 关闭 */
	confirmTimeoutSec: number;
	/** 窗口内执行：哪些角色走 subagent_inline，以及其确认超时 */
	dispatch: { inlineRoles: string[]; inlineConfirmTimeoutSec: number };
	features: Features;
	/** 追加到分派规则末尾 */
	policyAppend: string;
}

const FEATURE_KEYS: FeatureKey[] = ["autoModel", "relationCheck", "confirm", "contextWarn", "handoffAutoClose"];

const CONFIG_PATH = join(getAgentDir(), "task-router.json");
const CLOSE_LOG_PATH = join(getAgentDir(), "task-router-close.log");
const HANDOFF_DIR = join(getAgentDir(), "handoff");
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

function fmValue(fm: string, key: string): string | undefined {
	const raw = fm.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1].trim();
	if (!raw) return undefined;
	if (
		raw.length >= 2 &&
		((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
	)
		return raw.slice(1, -1);
	return raw;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
	if (value === "true") return true;
	if (value === "false") return false;
	return undefined;
}

interface AgentInfo {
	name: string;
	description: string;
	model?: string;
	thinking?: string;
	spawning?: boolean;
	dispatch: boolean;
	filePath: string;
}

function loadAgents(): { agents: AgentInfo[]; warnings: string[] } {
	const warnings: string[] = [];
	const byName = new Map<string, AgentInfo>();
	if (!existsSync(AGENTS_DIR)) {
		warnings.push(`角色目录不存在：${AGENTS_DIR}`);
		return { agents: [], warnings };
	}
	let entries: Dirent[];
	try {
		entries = readdirSync(AGENTS_DIR, { withFileTypes: true });
	} catch (e: any) {
		warnings.push(`读取角色目录失败（${String(e?.message ?? e).slice(0, 120)}）`);
		return { agents: [], warnings };
	}
	const files = entries
		.filter((e) => e.name.endsWith(".md") && (e.isFile() || e.isSymbolicLink()))
		.sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of files) {
		const filePath = join(AGENTS_DIR, entry.name);
		let content: string;
		try {
			content = readFileSync(filePath, "utf8");
		} catch (e: any) {
			warnings.push(`读取角色文件失败：${entry.name}（${String(e?.message ?? e).slice(0, 80)}），已跳过`);
			continue;
		}
		try {
			const fm = content.match(/^---\n([\s\S]*?)\n---/)?.[1];
			if (!fm) {
				warnings.push(`角色文件无 frontmatter：${entry.name}，已跳过`);
				continue;
			}
			const name = fmValue(fm, "name") || entry.name.replace(/\.md$/, "");
			if (!name) {
				warnings.push(`角色文件无名：${entry.name}，已跳过`);
				continue;
			}
			const info: AgentInfo = {
				name,
				description: fmValue(fm, "description") ?? "",
				model: fmValue(fm, "model"),
				thinking: fmValue(fm, "thinking"),
				spawning: parseOptionalBoolean(fmValue(fm, "spawning")),
				dispatch: parseOptionalBoolean(fmValue(fm, "dispatch")) !== false,
				filePath,
			};
			if (byName.has(name)) warnings.push(`角色名重复「${name}」（${entry.name}），后者覆盖前者`);
			byName.set(name, info);
		} catch (e: any) {
			warnings.push(`解析角色文件失败：${entry.name}（${String(e?.message ?? e).slice(0, 80)}），已跳过`);
		}
	}
	return { agents: [...byName.values()], warnings };
}

const AGENT_LOAD = loadAgents();
const AGENT_BY_NAME = new Map(AGENT_LOAD.agents.map((a) => [a.name, a]));
const DISPATCHABLE_ROLES = AGENT_LOAD.agents.filter((a) => a.name !== "session" && a.dispatch).map((a) => a.name);
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
	const analyzerRaw = raw.analyzer;
	if (!isPlainObject(analyzerRaw)) throw new Error("analyzer 必须是对象");
	const type = analyzerRaw.type;
	if (type !== "classifier" && type !== "chat") throw new Error('analyzer.type 必须是 "classifier" 或 "chat"');
	const timeoutMs = optNum(analyzerRaw.timeoutMs, 15_000, "analyzer.timeoutMs");
	if (timeoutMs <= 0) throw new Error("analyzer.timeoutMs 必须 > 0");
	const relationMinProb = optNum(raw.relationMinProb, 0.6, "relationMinProb");
	if (relationMinProb < 0 || relationMinProb > 1) throw new Error("relationMinProb 必须在 0–1");
	if (!isPlainObject(raw.contextWarn)) throw new Error("contextWarn 必须是对象");
	const tokens = raw.contextWarn.tokens;
	if (!Array.isArray(tokens) || tokens.length === 0 || tokens.some((t) => typeof t !== "number" || !Number.isFinite(t) || t <= 0))
		throw new Error("contextWarn.tokens 必须是正数数组");
	const percent = reqNum(raw.contextWarn.percent, "contextWarn.percent");
	const userTurns = reqNum(raw.contextWarn.userTurns, "contextWarn.userTurns");
	if (raw.roles != null && !isPlainObject(raw.roles)) throw new Error("roles 必须是对象");
	const roles: Record<string, RoleMeta> = {};
	const warnings: string[] = [];
	for (const [k, v] of Object.entries(isPlainObject(raw.roles) ? raw.roles : {})) {
		if (!isPlainObject(v)) {
			warnings.push(`roles.${k} 格式无效，已忽略`);
			continue;
		}
		if (!AGENT_BY_NAME.has(k)) {
			warnings.push(`roles.${k} 对应角色不存在，已忽略`);
			continue;
		}
		const meta: RoleMeta = {};
		if (typeof v.use === "string" && v.use.trim()) meta.use = v.use.trim();
		if (typeof v.hint === "string" && v.hint.trim()) meta.hint = v.hint.trim();
		roles[k] = meta;
	}
	const confirmTimeoutSec = optNum(raw.confirmTimeoutSec, 30, "confirmTimeoutSec");
	if (confirmTimeoutSec < 0) throw new Error("confirmTimeoutSec 必须是非负数（0 关闭自动执行）");
	if (!isPlainObject(raw.dispatch)) throw new Error("dispatch 必须是对象");
	const inlineRolesRaw = raw.dispatch.inlineRoles;
	if (!Array.isArray(inlineRolesRaw) || inlineRolesRaw.some((x) => typeof x !== "string"))
		throw new Error("dispatch.inlineRoles 必须是字符串数组");
	const inlineRoles: string[] = [];
	for (const r of inlineRolesRaw) {
		if (r === "session") {
			warnings.push("dispatch.inlineRoles 含 session，已忽略（session 始终开新窗口）");
			continue;
		}
		const agent = AGENT_BY_NAME.get(r);
		if (!agent) {
			warnings.push(`dispatch.inlineRoles 含未知角色「${r}」，已忽略`);
			continue;
		}
		if (!agent.dispatch || !DISPATCHABLE_SET.has(r)) {
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
	for (const k of FEATURE_KEYS) features[k] = reqBool(raw.features[k], `features.${k}`);
	if (raw.policyAppend != null && typeof raw.policyAppend !== "string") throw new Error("policyAppend 必须是字符串");
	const policyAppend = typeof raw.policyAppend === "string" ? raw.policyAppend : "";
	return {
		cfg: {
			models,
			default: inModels("default", raw.default),
			fallback: inModels("fallback", raw.fallback),
			analyzer: {
				type,
				provider: reqStr(analyzerRaw.provider, "analyzer.provider"),
				id: reqStr(analyzerRaw.id, "analyzer.id"),
				timeoutMs,
			},
			relationMinProb,
			contextWarn: { tokens: tokens as number[], percent, userTurns },
			roles,
			confirmTimeoutSec,
			dispatch: { inlineRoles, inlineConfirmTimeoutSec },
			features,
			policyAppend,
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
		default: "",
		fallback: "",
		analyzer: { type: "classifier", provider: "", id: "", timeoutMs: 15_000 },
		relationMinProb: 0.6,
		contextWarn: { tokens: [], percent: 100, userTurns: Number.MAX_SAFE_INTEGER },
		roles: {},
		confirmTimeoutSec: 0,
		dispatch: { inlineRoles: [], inlineConfirmTimeoutSec: 0 },
		features: { autoModel: false, relationCheck: false, confirm: true, contextWarn: false, handoffAutoClose: false },
		policyAppend: "",
	};
}

function loadConfig(): { cfg: RouterConfig; paused: boolean; warning?: string } {
	const agentWarn = AGENT_LOAD.warnings.join("\n") || undefined;
	const pause = (msg: string) => ({
		cfg: pausedConfig(),
		paused: true,
		warning: joinWarnings(`${msg}。已暂停自动路由（不注入分派策略、不自动选模型/分流）`, agentWarn),
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
const DEFAULT_PICK = CFG.default;
const FALLBACK = CFG.fallback;
const ANALYZER = CFG.analyzer;
const ANALYZER_TIMEOUT_MS = ANALYZER.timeoutMs;
const RELATION_MIN_PROB = CFG.relationMinProb;
const CONTEXT_WARN_TOKENS = CFG.contextWarn.tokens;
const CONTEXT_WARN_PERCENT = CFG.contextWarn.percent;
const USER_TURN_WARN = CFG.contextWarn.userTurns;
const ROLES = CFG.roles;
const CONFIRM_TIMEOUT_SEC = CFG.confirmTimeoutSec;
const INLINE_ROLES = CFG.dispatch.inlineRoles;
const INLINE_CONFIRM_TIMEOUT_SEC = CFG.dispatch.inlineConfirmTimeoutSec;
const INLINE_ROLE_SET = new Set(INLINE_ROLES);
const DISPATCH_ROLES = DISPATCHABLE_ROLES;
const WINDOW_ROLES = DISPATCH_ROLES.filter((r) => !INLINE_ROLE_SET.has(r));
const FEATURES = CFG.features;
const POLICY_APPEND = CFG.policyAppend.trim();
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
	if (IN_HERDR && !hasSubagentTool(pi)) {
		out.push(
			"开新窗口分派不可用：未找到 subagent 工具。请执行 pi install npm:pi-herdr-subagents，或把可分派角色写进 dispatch.inlineRoles。",
		);
	}
	if (IN_HERDR && IS_WIN32 && !WIN_BASH_ON_PATH) {
		out.push(
			"pi-herdr-subagents 开新窗口需要 bash。请把 Git Bash 的 bin 目录（如 C:\\Program Files\\Git\\bin）加入 PATH。",
		);
	}
	return out;
}

const SUBAGENT_ID = process.env.PI_SUBAGENT_ID; // pi-herdr-subagents 子窗口
const SUBAGENT_ROLE = process.env.PI_SUBAGENT_AGENT ?? "";
const SESSION_WINDOW = SUBAGENT_ROLE === "session";
const INLINE_SUBAGENT = process.env.PI_INLINE_SUBAGENT === "1";
const INLINE_AGENT = process.env.PI_INLINE_SUBAGENT_AGENT ?? "";
const CURRENT_AGENT = INLINE_SUBAGENT ? INLINE_AGENT : SUBAGENT_ROLE;
/** 子代理且 spawning:false（或未声明且不是 session）：不选模型、不注入分派规则、不能继续分派、不检测新任务、不弹确认、不提醒上下文 */
function computeIsWorker(): boolean {
	if (!INLINE_SUBAGENT && !SUBAGENT_ID) return false;
	const spawning = AGENT_BY_NAME.get(CURRENT_AGENT)?.spawning;
	if (spawning === false) return true;
	if (spawning === undefined && CURRENT_AGENT !== "session") return true;
	return false;
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

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((b: any) => (b?.type === "text" ? [b.text] : [])).join("\n");
}

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

function parseJson(text: string): any | undefined {
	const m = text.match(/\{[\s\S]*\}/);
	if (!m) return undefined;
	try {
		return JSON.parse(m[0]);
	} catch {
		return undefined;
	}
}

const isPick = (v: unknown): v is Pick => typeof v === "string" && v in MODELS;
const asLevel = (v: unknown, d: Level = "medium"): Level => (v === "low" || v === "medium" || v === "high" ? v : d);

function agentDefault(agent: string | undefined, field: "model" | "thinking"): string | undefined {
	if (!agent) return undefined;
	const loaded = AGENT_BY_NAME.get(agent)?.[field];
	if (loaded) return loaded;
	const file = join(AGENTS_DIR, `${agent}.md`);
	if (!existsSync(file)) return undefined;
	const fm = readFileSync(file, "utf8").match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
	return fmValue(fm, field);
}

const WORKER_DENY_SPAWN = IS_WORKER;

async function applyModel(pi: ExtensionAPI, ctx: ExtensionContext, pick: Pick, level: Level): Promise<boolean> {
	const spec = MODELS[pick];
	if (!spec) return false;
	const m = ctx.modelRegistry.find(spec.provider, spec.id);
	if (!m) return false;
	const ok = await pi.setModel(m);
	if (ok) pi.setThinkingLevel(level);
	return ok;
}

// ───────────────────────── 分析 ─────────────────────────

type Relation = "continuation" | "subtask" | "independent";
interface FirstResult { model: Pick; thinking: Level; scenario?: string; difficulty?: string; reason: string }
interface NextResult { relation: Relation; model?: Pick; thinking?: Level; reason: string }

const ANALYZER_REF = `${ANALYZER.provider}/${ANALYZER.id}`;
const DIFFICULTY_LEVEL: Record<string, Level> = { easy: "low", medium: "medium", hard: "high" };
const MODEL_CRITERIA = Object.fromEntries((Object.keys(MODELS) as Pick[]).map((k) => [k, MODELS[k].desc]));
const DIFFICULTY_CRITERIA = {
	easy: "简单：问答、小脚本、机械修改、跑命令",
	medium: "中等：常规功能、修 bug、按计划实现",
	hard: "困难：架构设计、跨模块重构、疑难调试、复杂算法",
};
async function chatJson(ctx: ExtensionContext, model: any, system: string, user: string): Promise<any> {
	const res = await ctx.modelRegistry.complete(
		model,
		{ systemPrompt: system, messages: [{ role: "user", content: [{ type: "text", text: user }], timestamp: Date.now() }] },
		{ signal: AbortSignal.timeout(ANALYZER_TIMEOUT_MS * 2), cacheRetention: "none" } as any,
	);
	if (res.stopReason === "error" || res.stopReason === "aborted") throw new Error(res.errorMessage ?? res.stopReason);
	const j = parseJson(textOf(res.content));
	if (!j) throw new Error("输出不是 JSON");
	return j;
}

async function classifyAnswers(ctx: ExtensionContext, state: Record<string, unknown>, questions: Record<string, any>) {
	const m = ctx.modelRegistry.findOfType("classifier", ANALYZER.provider, ANALYZER.id);
	if (!m) throw new Error("模型不在目录中或未配置凭据");
	const r = await ctx.modelRegistry.classify(m, { state, questions }, { signal: AbortSignal.timeout(ANALYZER_TIMEOUT_MS) } as any);
	if (r.stopReason !== "stop") throw new Error(r.errorMessage ?? r.stopReason);
	return r.answers as Record<string, any>;
}

const pct = (a: any) => `${Math.round((a?.probabilities?.[a.choice] ?? 0) * 100)}%`;

function normalizeFirst(j: any): FirstResult | undefined {
	if (!j || !isPick(j.model)) return undefined;
	return { model: j.model, thinking: asLevel(j.thinking), scenario: j.scenario, difficulty: j.difficulty, reason: j.reason ?? "" };
}

function normalizeNext(j: any): NextResult | undefined {
	if (!j) return undefined;
	const relation: Relation = j.relation === "subtask" || j.relation === "independent" ? j.relation : "continuation";
	return { relation, model: isPick(j.model) ? j.model : undefined, thinking: asLevel(j.thinking), reason: j.reason ?? "" };
}

// ───────────────────────── 判断提示 ─────────────────────────

const FIRST_SYSTEM = `你是任务路由器。根据用户在一个新 coding agent 会话中的第一条任务，选择最合适的模型。本会话之后会一直使用该模型。
可选模型（括号内为代号）：
${modelTable}
原则：能用便宜模型完成就不用贵的；最强/最贵的模型只给真正高难的设计/编排/疑难任务。
只输出 JSON：{"model":"${PICK_ALT}","thinking":"low|medium|high","scenario":"简短场景","difficulty":"easy|medium|hard","reason":"一句话理由"}`;

const NEXT_SYSTEM = `你是任务路由器。一个 coding agent 会话有一个主题任务。判断用户的新消息与该主题的关系：
- continuation：主题任务的推进、追问、修正、讨论、规划，适合留在本会话
- subtask：主题任务下可以独立执行的一段工作（编排/计划完成后的编码、验证、测试，一轮新的编码，清理缓存等小杂务），适合开新窗口用短上下文执行
- independent：与主题无关的新任务
可选模型（括号内为代号）：
${modelTable}
如果不是 continuation，再为它推荐模型。拿不准时选 continuation。
只输出 JSON：{"relation":"continuation|subtask|independent","model":"${PICK_ALT}","thinking":"low|medium|high","reason":"一句话理由"}`;

const CONTINUE_RE =
	/^(继续|好|好的|ok|可以|行|嗯|是的?|对|不|不用|算了|重试|再试|go|yes|no|y|n)\b|刚才|上面|前面|这个|那个|这里|那里|这段|那段|接着|再(改|加|跑|试|看|检查)|为什么|怎么回事|报错|错误|失败/i;

function heuristicFirst(text: string): { model: Pick; thinking: Level; reason: string } | undefined {
	const m = text.match(PREFIX_RE);
	if (m) return { model: m[1].toLowerCase(), thinking: "medium", reason: "手动指定" };
	return undefined;
}

// ───────────────────────── 系统提示 ─────────────────────────

function roleLine(r: string): string {
	const agent = AGENT_BY_NAME.get(r);
	const meta = ROLES[r] ?? {};
	const use = meta.use || agent?.description || r;
	const extras = [agent?.model ? `默认 ${agent.model}` : undefined, meta.hint].filter(Boolean);
	const suffix = extras.length ? `（${extras.join("；")}）` : "";
	return `${use} → agent: "${r}"${suffix}`;
}

const INLINE_ROLE_LINES = INLINE_ROLES.map((r) => `- ${roleLine(r)}`).join("\n");
const WINDOW_ROLE_LINES = WINDOW_ROLES.map((r) => `- ${roleLine(r)}`).join("\n");
const DISPATCH_ROLE_LINES = DISPATCH_ROLES.map((r) => `- ${roleLine(r)}`).join("\n");

const POLICY_TASK_SELF_CONTAINED =
	"- task 必须自包含（子代理看不到本会话）：背景、相关文件、已定决策、具体任务、验收标准、汇报要点；不要带入无关内容。";
const POLICY_MODEL_ID = "- model 用完整的 provider/id。";
const POLICY_DISPATCH_RULES = `规则：
- 当主题任务进入可独立执行的阶段，或出现无关任务、小杂务时，分派出去，不要在本会话中执行。
- 收到子任务汇报后，在本会话中做判断和下一步编排。`;
const POLICY_COST =
	'- 请用户在方案间做选择时，凡会引入新机制、明显增加代码量或依赖第三方内部实现的选项，附一句代价说明（"选 X 需要额外实现 Y，风险是 Z"）。';

function buildPolicy(herdr: boolean): string {
	const header = herdr
		? "本会话固定使用一个模型，一个会话只做一件主题任务，保持上下文短而干净。可用模型："
		: "本会话固定使用一个模型，一个会话只做一件主题任务。当前不在 herdr 中，无法开新窗口；session 交接与 /route handoff、/route new 不可用。可用模型：";
	const sessionHandoffNote = SESSION_WINDOW
		? `\n- 本窗口是 session，不能再用 subagent(agent:"session")。无关新任务同样写到 ${HANDOFF_DIR}/<名称>-<日期时间>.md 再调用 handoff_open，结果不回传。`
		: "";
	const tools = herdr
		? `按角色选择工具：
${
				INLINE_ROLES.length
					? `窗口内同步执行（工具 subagent_inline，结果直接返回；多个窗口内子任务用 tasks 模式一次性提交）：\n${INLINE_ROLE_LINES}\n`
					: ""
			}开新窗口异步执行（工具 subagent，结果会自动回到本会话，不要轮询或等待）：
${WINDOW_ROLE_LINES ? `${WINDOW_ROLE_LINES}\n` : ""}- 交接当前任务：把自包含说明写到 ${HANDOFF_DIR}/<名称>-<日期时间>.md（目标、当前进度、关键决定、相关文件、未完成步骤、注意事项，以及「第一步」），再调用 handoff_open（file、model、thinking）。新窗口是普通会话，结果不回传。交接默认沿用当前模型。
- 与主题无关的新任务 → agent: "session"，按任务难度显式传 model 和 thinking。/route new 始终开新窗口，不能用 subagent_inline。${sessionHandoffNote}`
		: `用 subagent_inline 在当前窗口后台同步执行可独立完成的工作（结果直接返回；多个子任务用 tasks 模式一次性提交）：
${DISPATCH_ROLE_LINES}`;
	const extra = herdr
		? `${POLICY_TASK_SELF_CONTAINED}
${POLICY_MODEL_ID}

${POLICY_DISPATCH_RULES.replace(
				"不要在本会话中执行。",
				"不要在本会话中执行；不要把多个阶段或多个任务都塞进本会话。",
			)}
- 多个新窗口子任务并行时，收到部分结果只做一句简短确认，不调用工具；等全部回来再统一编排。窗口内并行任务用一次 subagent_inline（tasks）提交，等这次调用返回后再编排。
- 如果本会话中无关或过时的内容已经很多，主动建议用户执行 /route handoff。
- 用户说"在这里做/不用开新窗口"时，照做。
- 用户明确要求本次换一种执行方式时，照做，用另一个工具。
${POLICY_COST}`
		: `${POLICY_TASK_SELF_CONTAINED.replace("子代理", "子进程")}
${POLICY_MODEL_ID}
- 需要全新会话时，写一份自包含提示词交给用户，建议用户在新会话中执行。不要用 subagent_inline 调用 session。

${POLICY_DISPATCH_RULES}
- 用户说"在这里做"时，照做。
${POLICY_COST}`;
	return `
# 任务分派（task-router）
${header}
${modelTable}

${tools}
${extra}${POLICY_APPEND ? `\n${POLICY_APPEND}` : ""}`;
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

function isPathInsideDir(root: string, file: string): boolean {
	const rel = relative(root, file);
	if (!rel || isAbsolute(rel)) return false;
	return rel.split(/[/\\]/)[0] !== "..";
}

function resolveHandoffFile(file: string): string {
	const resolved = resolve(file.startsWith("~/") ? join(homedir(), file.slice(2)) : file);
	const root = resolve(HANDOFF_DIR);
	if (!isPathInsideDir(root, resolved)) throw new Error(`交接文件必须在 ${HANDOFF_DIR} 下`);
	if (!existsSync(resolved) || !statSync(resolved).isFile()) throw new Error(`交接文件不存在：${resolved}`);
	return resolved;
}

function openHandoffSession(file: string, model: string, thinking: string, cwd: string): { tabId: string; paneId: string; agent: string } {
	const ws = process.env.HERDR_WORKSPACE_ID;
	if (!ws) throw new Error("找不到 HERDR_WORKSPACE_ID");
	const stem = basename(file, ".md").replace(/[^\w.-]+/g, "-").slice(0, 40) || "handoff";
	const created = herdrJson(["tab", "create", "--workspace", ws, "--cwd", cwd, "--label", `handoff: ${stem}`, "--focus"]);
	const tabId = created?.result?.tab?.tab_id;
	const paneId = created?.result?.root_pane?.pane_id;
	if (typeof tabId !== "string" || typeof paneId !== "string") throw new Error("herdr tab create 未返回 tab/pane id");
	const agent = `ho${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.slice(0, 32);
	try {
		// Windows 上跳过：pane 的 shell 不确定（cmd / PowerShell / 用户配置），POSIX unset 片段无法可靠执行。
		if (!IS_WIN32) {
			execFileSync(
				"herdr",
				["pane", "run", paneId, 'for __v in $(env | awk -F= \'/^(PI_SUBAGENT_|PI_INLINE_)/{print $1}\'); do unset "$__v"; done'],
				{ encoding: "utf8", timeout: 10_000 },
			);
		}
		sleepSync(400);
		herdrJson(["agent", "start", agent, "--kind", "pi", "--pane", paneId, "--timeout", "60000", "--", "--model", model, "--thinking", thinking], 70_000);
	} catch (e) {
		try {
			execFileSync("herdr", ["tab", "close", tabId], { encoding: "utf8", timeout: 10_000 });
		} catch {}
		throw e;
	}
	try {
		herdrJson(["agent", "prompt", agent, `读取交接文件 ${file} 并按其中「第一步」开始。`]);
	} catch (e: any) {
		throw new Error(`新会话已启动（tab ${tabId}，pane ${paneId}），但发送交接指令失败，请在该窗口手动让它读取 ${file}：${e?.message ?? e}`);
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
};

export default function (pi: ExtensionAPI) {
	let detectionOff = false;
	let confirmOn = FEATURES.confirm;
	let analyzerDown = false;
	/** /route handoff 本轮：handoff_open 成功后，在 agent_settled 询问是否关闭本窗口 */
	let handoffPending = false;
	let handoffOpened = false;
	const enqueueDispatchConfirm = createSerialQueue();

	if (IN_HERDR) {
		pi.registerTool({
			name: "handoff_open",
			label: "交接开窗",
			description:
				`读取 ${HANDOFF_DIR}/ 下已写好的交接文件，在当前 workspace 新开 tab 启动普通 pi 会话（去掉 PI_SUBAGENT_* / PI_INLINE_*，不受子代理监视、不回传）。参数：file、model（provider/id）、thinking。`,
			promptSnippet: `把交接说明写到 ${HANDOFF_DIR}/<名称>-<日期时间>.md 后调用，开新 tab 接手。`,
			parameters: Type.Object({
				file: Type.String({ description: `交接文件路径，必须在 ${HANDOFF_DIR}/ 下` }),
				model: Type.String({ description: "新会话模型，provider/id" }),
				thinking: Type.String({ description: "思考等级，如 low|medium|high" }),
			}),
			executionMode: "sequential",
			async execute(_id, params, _signal, _onUpdate, ctx) {
				if (IS_WORKER) throw new Error("当前角色不允许交接");
				const file = resolveHandoffFile(params.file);
				const model = params.model.trim();
				const thinking = params.thinking.trim();
				if (!model || !thinking) throw new Error("model 和 thinking 不能为空");
				const opened = openHandoffSession(file, model, thinking, ctx.cwd);
				return {
					content: [{ type: "text", text: `已在新 tab 启动会话（${opened.tabId} / ${opened.agent}）。这是普通会话，结果不会回传。` }],
					details: opened,
				};
			},
		});
	}

	pi.on("session_start", (_event, ctx) => {
		if (CONFIG_WARNING) {
			if (ctx.hasUI) ctx.ui.notify(CONFIG_WARNING, ROUTING_PAUSED ? "error" : "warning");
			else if (ROUTING_PAUSED) console.error(`[task-router] ${CONFIG_WARNING}`);
		}
		const runtimeWarnings = collectRuntimeWarnings(pi);
		if (runtimeWarnings.length === 0) return;
		const msg = runtimeWarnings.join("\n");
		if (ctx.hasUI) ctx.ui.notify(msg, "warning");
		else console.error(`[task-router] ${msg}`);
	});

	/** 先用分析模型；失败时改用当前会话模型并提示。都失败返回 undefined。 */
	async function analyze<T>(
		ctx: ExtensionContext,
		viaClassifier: () => Promise<T | undefined>,
		viaChat: (model: any) => Promise<T | undefined>,
	): Promise<T | undefined> {
		try {
			let r: T | undefined;
			if (ANALYZER.type === "classifier") r = await viaClassifier();
			else {
				const m = ctx.modelRegistry.find(ANALYZER.provider, ANALYZER.id);
				if (!m) throw new Error("模型不在目录中或未配置凭据");
				r = await viaChat(m);
			}
			if (analyzerDown) {
				analyzerDown = false;
				ctx.ui.setStatus("task-router-analyzer", undefined);
				ctx.ui.notify(`✓ 分析模型 ${ANALYZER_REF} 已恢复`, "info");
			}
			return r;
		} catch (e: any) {
			const cur = ctx.model;
			const curRef = cur ? `${cur.provider}/${cur.id}` : undefined;
			if (!analyzerDown) {
				analyzerDown = true;
				ctx.ui.notify(
					`⚠ 分析模型 ${ANALYZER_REF} 不可用（${String(e?.message ?? e).slice(0, 120)}）${curRef ? `，改用当前模型 ${curRef} 分析` : ""}`,
					"warning",
				);
				ctx.ui.setStatus("task-router-analyzer", `分析：${curRef ?? "无"}（${ANALYZER.id} 不可用）`);
			}
			if (!cur || curRef === ANALYZER_REF) return undefined;
			try {
				return await viaChat(cur);
			} catch (e2: any) {
				ctx.ui.notify(`⚠ 当前模型分析也失败（${String(e2?.message ?? e2).slice(0, 80)}），按默认处理`, "warning");
				return undefined;
			}
		}
	}

	const analyzeFirst = (ctx: ExtensionContext, text: string) =>
		analyze<FirstResult>(
			ctx,
			async () => {
				const a = await classifyAnswers(ctx, { task: text.slice(0, 12_000) }, {
					model: {
						type: "choice",
						instructions: "Pick the cheapest model that can handle the coding-agent task in `task` well. Reserve the strongest/most expensive model for truly hard design/orchestration work.",
						criteria: MODEL_CRITERIA,
					},
					difficulty: { type: "choice", instructions: "How demanding is the task in `task`?", criteria: DIFFICULTY_CRITERIA },
				});
				const model = a.model?.choice;
				if (!isPick(model)) return undefined;
				const difficulty = a.difficulty?.choice;
				return {
					model,
					thinking: DIFFICULTY_LEVEL[difficulty] ?? "medium",
					difficulty,
					reason: `${ANALYZER.id}：${model} ${pct(a.model)}，难度 ${difficulty ?? "?"}`,
				};
			},
			async (m) => normalizeFirst(await chatJson(ctx, m, FIRST_SYSTEM, text.slice(0, 12_000))),
		);

	const analyzeNext = (ctx: ExtensionContext, topic: string, lastAssistant: string, text: string) =>
		analyze<NextResult>(
			ctx,
			async () => {
				const a = await classifyAnswers(
					ctx,
					{ session_topic: topic, last_assistant_reply: lastAssistant, new_user_message: text.slice(0, 6000) },
					{
						relation: {
							type: "choice",
							instructions: "How does `new_user_message` relate to the coding-agent session whose main task is `session_topic`?",
							criteria: {
								continuation: "推进、追问、修正、讨论或规划主题任务，适合留在本会话",
								subtask: "主题任务下可独立执行的一段工作：计划完成后的编码、验证、测试，新一轮编码，清理缓存等小杂务",
								independent: "与主题任务无关的新任务",
							},
						},
						model: { type: "choice", instructions: "Pick the cheapest model that can handle `new_user_message` well.", criteria: MODEL_CRITERIA },
						difficulty: { type: "choice", instructions: "How demanding is `new_user_message`?", criteria: DIFFICULTY_CRITERIA },
					},
				);
				const rel = a.relation?.choice as Relation;
				const confident = (a.relation?.probabilities?.[rel] ?? 0) >= RELATION_MIN_PROB;
				const relation: Relation = confident && (rel === "subtask" || rel === "independent") ? rel : "continuation";
				const model = isPick(a.model?.choice) ? (a.model.choice as Pick) : undefined;
				return {
					relation,
					model,
					thinking: DIFFICULTY_LEVEL[a.difficulty?.choice] ?? "medium",
					reason: `${ANALYZER.id}：${rel} ${pct(a.relation)}${model ? `，推荐 ${model} ${pct(a.model)}` : ""}`,
				};
			},
			async (m) =>
				normalizeNext(
					await chatJson(
						ctx,
						m,
						NEXT_SYSTEM,
						`## 会话主题\n${topic}\n\n## 最近一次助手回复（节选）\n${lastAssistant}\n\n## 用户新消息\n${text.slice(0, 6000)}`,
					),
				),
		);
	const warned = new Set<string>();

	function dispatchText(kind: string, original: string, suggestion?: string): string {
		const sug = suggestion ? `路由建议模型：${suggestion}；可根据上下文调整。` : "";
		const how =
			IN_HERDR && SESSION_WINDOW && kind !== "子任务"
				? `写到 ${HANDOFF_DIR}/<名称>-<日期时间>.md（含「第一步」），再调用 handoff_open（file、model、thinking）。新窗口是普通会话，结果不回传。${sug}`
				: IN_HERDR && kind !== "子任务"
					? `调用 subagent（agent: "session"）开新窗口，按任务难度显式传 model 和 thinking。${sug}`
				: IN_HERDR
					? `调用工具分派：${INLINE_ROLES.join(" / ") || "（无）"} 用 subagent_inline（窗口内同步）；${WINDOW_ROLES.join(" / ") || "（无）"} 用 subagent（开新窗口）；session 始终 subagent。${sug}`
					: `调用 subagent_inline 分派（${DISPATCH_ROLES.join(" / ") || "（无）"}，窗口内同步）。session 在此环境不可用。${sug}`;
		return `[task-router] 用户提出了下面这个应分派出去的${kind}。不要在本会话中执行它。结合当前会话上下文写一份自包含的任务提示词，${how}\n\n用户原话：\n${original}`;
	}

	// 系统提示注入（自动执行的子窗口由角色定义负责，不注入）
	pi.on("before_agent_start", (event) => {
		if (IS_WORKER || ROUTING_PAUSED) return;
		return { systemPrompt: event.systemPrompt + "\n" + (IN_HERDR ? POLICY_HERDR : POLICY_PLAIN) };
	});

	// 输入拦截
	pi.on("input", async (event, ctx) => {
		if (IS_WORKER || event.source !== "interactive" || event.streamingBehavior) return { action: "continue" };
		let text = event.text.trim();
		if (!text || text.startsWith("/") || text.startsWith("!")) return { action: "continue" };

		const msgs = branchMessages(ctx);
		const hasUser = msgs.some((m) => m.role === "user");

		if (text.startsWith(">>")) return { action: "transform", text: dispatchText("新任务", text.slice(2).trim()) };

		// 首条消息：选模型
		if (!hasUser) {
			if (SUBAGENT_ID || INLINE_SUBAGENT || EXPLICIT_MODEL) return { action: "continue" };
			const modelChanges = ctx.sessionManager.getBranch().filter((e: any) => e.type === "model_change").length;
			if (modelChanges > 1) return { action: "continue" };

			const pick = heuristicFirst(text);
			if (pick?.reason === "手动指定") text = text.replace(PREFIX_RE, "").trimStart();
			else if (!FEATURES.autoModel) return { action: "continue" };
			let info: any = pick;
			if (!pick) {
				ctx.ui.setStatus("task-router", "⇢ 分析任务…");
				const j = await analyzeFirst(ctx, text);
				ctx.ui.setStatus("task-router", undefined);
				info = j ?? { model: DEFAULT_PICK, thinking: "medium", reason: "判断失败，使用默认" };
			}
			const p: Pick = info.model;
			const lv = asLevel(info.thinking);
			const ok = await applyModel(pi, ctx, p, lv);
			const label = `${MODELS[p].id} • ${lv}`;
			ctx.ui.notify(
				ok
					? `⇢ 本会话模型：${label}${info.scenario ? `\n  ${info.scenario} / ${info.difficulty}` : ""} ｜ ${info.reason}`
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
			return text === event.text.trim() ? { action: "continue" } : { action: "transform", text };
		}

		// 后续消息：判断关系（>> 前缀在上方已处理，关 relationCheck 后仍有效）
		if (!FEATURES.relationCheck || detectionOff || text.length < 20 || CONTINUE_RE.test(text)) return { action: "continue" };
		const topic = routerEntry(ctx)?.topic ?? textOf(msgs.find((m) => m.role === "user")?.content).slice(0, 500);
		const lastAssistant = textOf([...msgs].reverse().find((m) => m.role === "assistant")?.content).slice(-1500);
		ctx.ui.setStatus("task-router", "⇢ 判断任务关系…");
		const j = await analyzeNext(ctx, topic, lastAssistant, text);
		ctx.ui.setStatus("task-router", undefined);
		if (!j || j.relation === "continuation") return { action: "continue" };

		const kind = j.relation === "subtask" ? "子任务" : "独立新任务";
		const sug = j.model ? `${ref(j.model)} • ${asLevel(j.thinking)}` : undefined;
		const choice = await ctx.ui.select(`💡 这像是一个${kind}：${j.reason ?? ""}${sug ? `\n   推荐模型：${sug}` : ""}`, [
			IN_HERDR ? "让当前 agent 写提示词并开新窗口执行" : "让当前 agent 写提示词并用窗口内子代理执行",
			"在本会话继续",
		]);
		if (choice === undefined) {
			ctx.ui.notify("已取消发送", "info");
			return { action: "handled" };
		}
		if (choice.startsWith("让当前")) return { action: "transform", text: dispatchText(kind, text, sug) };
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
		// session 角色是交接/独立会话窗口，由用户决定何时结束
		if (event.toolName === "subagent_done" && SUBAGENT_ROLE === "session") {
			return {
				block: true,
				reason: "这是交接/独立会话窗口，由用户决定何时结束。不要调用 subagent_done，汇报当前状态后等待用户的下一条指令。",
			};
		}
		if (WORKER_DENY_SPAWN && SPAWN_TOOL_NAMES.has(event.toolName)) {
			return {
				block: true,
				reason:
					"当前角色不允许继续分派。不要调用 subagent、subagent_inline、subagent_interrupt、subagent_resume、subagents_list、handoff_open，直接完成任务。",
			};
		}
		const isInline = event.toolName === "subagent_inline";
		const isWindow = event.toolName === "subagent";
		if (!isInline && !isWindow) return;
		const input = event.input as any;
		const jobs = dispatchJobs(input);
		if (isInline && jobs.some((j) => j.agent === "session")) {
			return {
				block: true,
				reason: IN_HERDR
					? "session 角色必须开新窗口，不能用 subagent_inline。请改用 subagent（agent: \"session\"）。"
					: "session 角色在非 herdr 环境中不可用，不能用 subagent_inline。请把自包含提示词交给用户在新会话中执行。",
			};
		}
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
		description: "task-router：status | handoff [说明] | new <任务> | off | on | confirm on|off",
		handler: async (args, ctx) => {
			const [sub, ...rest] = args.trim().split(/\s+/);
			const extra = rest.join(" ");
			const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "当前模型";
			switch (sub || "status") {
				case "handoff":
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
						`[task-router] 把当前任务交接到新窗口。写一份自包含的交接说明到 ${HANDOFF_DIR}/<名称>-<日期时间>.md：目标、当前进度、关键决定、相关文件、未完成步骤、注意事项，以及「第一步」（告诉新会话先做什么）；丢弃已过时或无关的内容。${
							IN_HERDR
								? `然后调用 handoff_open（file: 该文件路径，model: "${current}"，thinking: "${ctx.thinkingLevel ?? "medium"}"，除非剩余工作明显更适合其他模型）。`
								: "然后把提示词完整输出给用户，建议用户在新会话中继续。"
						}${extra ? `\n用户补充：${extra}` : ""}`,
					);
					return;
				case "new":
					if (!extra) return ctx.ui.notify("用法：/route new <任务>", "warning");
					pi.sendUserMessage(dispatchText("新任务", extra));
					return;
				case "off":
					detectionOff = true;
					return ctx.ui.notify("本会话已关闭新任务检测", "info");
				case "on":
					detectionOff = false;
					return ctx.ui.notify("本会话已开启新任务检测", "info");
				case "confirm":
					confirmOn = rest[0] !== "off";
					return ctx.ui.notify(`分派前确认：${confirmOn ? "开" : "关"}`, "info");
				default: {
					const r = routerEntry(ctx);
					const u = ctx.getContextUsage();
					const rolePlace = (name: string) => (IN_HERDR && !INLINE_ROLE_SET.has(name) ? "新窗口" : "窗口内");
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
							`分析模型：${ANALYZER_REF}${analyzerDown ? "（不可用，改用当前模型）" : ""}`,
							`配置：${ROUTING_PAUSED ? "已暂停（读取/校验失败）" : CONFIG_PATH}`,
							`新任务检测：${detectionOff ? "关" : "开"} ｜ 分派确认：${confirmOn ? "开" : "关"} ｜ herdr：${IN_HERDR ? "是" : "否"}`,
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
							`policyAppend：${POLICY_APPEND ? `已设置（${POLICY_APPEND.length} 字）` : "未设置"}`,
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
