/**
 * subagent_inline — 在当前窗口后台同步执行子代理（基于 pi 官方 subagent 示例）
 *
 * 为每次调用另起 `pi` 进程，隔离上下文；结果作为工具返回值交回，不开新 herdr 窗口。
 *
 * 模式：
 *   - 单个: { agent: "name", task: "..." }
 *   - 并行: { tasks: [{ agent: "name", task: "..." }, ...] }
 *
 * 可选 model / thinking 可覆盖角色 frontmatter；子进程设置 PI_INLINE_SUBAGENT / PI_INLINE_SUBAGENT_AGENT。
 * 角色 frontmatter 的 auto-exit 与 interactive 只对新窗口执行（subagent）生效，窗口内子进程不读这两项。
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getAgentDir, getMarkdownTheme, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, discoverAgents, shouldDenySpawning, SPAWNING_DENIED_TOOLS } from "./agents.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
const COLLAPSED_OUTPUT_CHARS = 800;
const COLLAPSED_OUTPUT_LINES = 8;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	signal?: string;
}

function isChildAlive(proc: { exitCode: number | null; signalCode: NodeJS.Signals | null }): boolean {
	return proc.exitCode === null && proc.signalCode === null;
}

function exitFromClose(code: number | null, signal: NodeJS.Signals | null): { exitCode: number; signal?: NodeJS.Signals } {
	if (signal) return { exitCode: 1, signal };
	if (code === null) return { exitCode: 1 };
	return { exitCode: code };
}

function abortedResult(agentName: string, task: string, model: string | undefined): SingleResult {
	return {
		agent: agentName,
		task,
		exitCode: 1,
		messages: [],
		stderr: "Subagent was aborted",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model,
		stopReason: "aborted",
		errorMessage: "Subagent was aborted",
	};
}

interface SubagentDetails {
	mode: "single" | "parallel";
	results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function resultStatus(result: SingleResult): "running" | "success" | "failed" | "aborted" {
	if (result.exitCode === -1) return "running";
	if (result.stopReason === "aborted") return "aborted";
	if (isFailedResult(result)) return "failed";
	return "success";
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

function collapseOutput(output: string): string {
	const lines = output.split("\n");
	if (lines.length <= COLLAPSED_OUTPUT_LINES && output.length <= COLLAPSED_OUTPUT_CHARS) return output;
	let text = lines.slice(0, COLLAPSED_OUTPUT_LINES).join("\n");
	if (text.length > COLLAPSED_OUTPUT_CHARS) text = text.slice(0, COLLAPSED_OUTPUT_CHARS);
	return `${text}\n…`;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

/** Strip parent herdr-subagent / inline-subagent identity so the child is not treated as a nested window worker. */
function childProcessEnv(agent: AgentConfig): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key === "PI_DENY_TOOLS" || key.startsWith("PI_SUBAGENT_") || key.startsWith("PI_INLINE_SUBAGENT")) {
			delete env[key];
		}
	}
	env.PI_INLINE_SUBAGENT = "1";
	env.PI_INLINE_SUBAGENT_AGENT = agent.name;
	// pi-herdr-subagents only honors PI_DENY_TOOLS when PI_SUBAGENT_ID is set (new-window workers).
	// Inline children do not set PI_SUBAGENT_ID; task-router still blocks these tools in tool_call.
	if (shouldDenySpawning(agent)) env.PI_DENY_TOOLS = SPAWNING_DENIED_TOOLS.join(",");
	return env;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: process.platform === "win32" ? "pi.cmd" : "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const ThinkingLevelSchema = StringEnum(THINKING_LEVELS, {
	description: "思考等级。省略则用角色 frontmatter 的 thinking，再回退到当前会话。传值会覆盖角色默认。",
});

interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

interface RuntimeOverrides {
	model?: string;
	thinking?: string;
}

async function runSingleAgent(
	defaultCwd: string,
	dispatchDefaults: DispatchDefaults,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	overrides?: RuntimeOverrides,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	const model = overrides?.model ?? agent.model ?? dispatchDefaults.model;
	const thinking = overrides?.thinking ?? agent.thinking ?? dispatchDefaults.thinkingLevel;
	if (model) args.push("--model", model);
	if (thinking) args.push("--thinking", thinking);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (signal?.aborted) return abortedResult(agentName, task, model);

		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		if (signal?.aborted) return abortedResult(agentName, task, model);

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const winCmd = process.platform === "win32" && /\.cmd$/i.test(invocation.command);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: winCmd,
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"],
				env: childProcessEnv(agent),
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			let killTimer: ReturnType<typeof setTimeout> | undefined;
			const onAbort = () => {
				wasAborted = true;
				try {
					proc.kill("SIGTERM");
				} catch {
					/* already dead */
				}
				killTimer = setTimeout(() => {
					if (isChildAlive(proc)) {
						try {
							proc.kill("SIGKILL");
						} catch {
							/* ignore */
						}
					}
				}, 5000);
			};
			const cleanupAbort = () => {
				if (killTimer !== undefined) clearTimeout(killTimer);
				killTimer = undefined;
				signal?.removeEventListener("abort", onAbort);
			};

			proc.on("close", (code, procSignal) => {
				cleanupAbort();
				if (buffer.trim()) processLine(buffer);
				const ended = exitFromClose(code, procSignal);
				if (ended.signal) {
					currentResult.signal = ended.signal;
					if (!currentResult.stopReason) currentResult.stopReason = "aborted";
					if (!currentResult.errorMessage) currentResult.errorMessage = `killed by ${ended.signal}`;
				}
				resolve(ended.exitCode);
			});

			proc.on("error", () => {
				cleanupAbort();
				resolve(1);
			});

			if (signal) {
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) return abortedResult(agentName, task, model);
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "要调用的角色名" }),
	task: Type.String({ description: "交给该角色的任务" }),
	cwd: Type.Optional(Type.String({ description: "子进程工作目录" })),
	model: Type.Optional(Type.String({ description: "覆盖该任务的模型，provider/id" })),
	thinking: Type.Optional(ThinkingLevelSchema),
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "角色名（单个任务模式）" })),
	task: Type.Optional(Type.String({ description: "任务（单个任务模式）" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "并行任务数组 {agent, task}，可带 model/thinking" })),
	cwd: Type.Optional(Type.String({ description: "子进程工作目录（单个任务模式）" })),
	model: Type.Optional(
		Type.String({
			description: "覆盖模型，provider/id。省略则用角色 frontmatter，再回退到当前会话。",
		}),
	),
	thinking: Type.Optional(ThinkingLevelSchema),
});

export { isChildAlive, exitFromClose, abortedResult };

function taskPreview(task: string, max = 60): string {
	return task.length > max ? `${task.slice(0, max)}...` : task;
}

function aggregateUsage(results: SingleResult[]) {
	const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	for (const r of results) {
		total.input += r.usage.input;
		total.output += r.usage.output;
		total.cacheRead += r.usage.cacheRead;
		total.cacheWrite += r.usage.cacheWrite;
		total.cost += r.usage.cost;
		total.turns += r.usage.turns;
	}
	return total;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent_inline",
		label: "窗口内子代理",
		description: [
			"在当前窗口后台同步执行子任务，结果作为本次工具调用的返回值直接交回（不开新 herdr 窗口，也不要轮询）。",
			"模式：单个（agent + task）、并行（tasks 数组）。",
			"可选参数 model、thinking 覆盖角色默认；tasks 的每一项也可单独指定。",
			"不要用此工具调用 session（交接/独立会话必须开新窗口）。",
			`只加载用户级角色（${path.join(getAgentDir(), "agents")}）。`,
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const dispatchDefaults: DispatchDefaults = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
			};
			const agents = discoverAgents();

			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel") =>
				(results: SingleResult[]): SubagentDetails => ({ mode, results });

			if (modeCount !== 1) {
				const available = agents.map((a) => a.name).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				const allResults: SingleResult[] = new Array(params.tasks.length);

				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						task: params.tasks[i].task,
						exitCode: -1,
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						dispatchDefaults,
						agents,
						t.agent,
						t.task,
						t.cwd,
						signal,
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
						{ model: t.model ?? params.model, thinking: t.thinking ?? params.thinking },
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateParallelOutput(getResultOutput(r));
					const status = resultStatus(r);
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent && params.task) {
				const result = await runSingleAgent(
					ctx.cwd,
					dispatchDefaults,
					agents,
					params.agent,
					params.task,
					params.cwd,
					signal,
					onUpdate,
					makeDetails("single"),
					{ model: params.model, thinking: params.thinking },
				);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => a.name).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent_inline ")) +
					theme.fg("accent", `parallel (${args.tasks.length})`);
				for (const t of args.tasks.slice(0, 3)) {
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${taskPreview(t.task, 40)}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? taskPreview(args.task) : "...";
			return new Text(
				theme.fg("toolTitle", theme.bold("subagent_inline ")) +
					theme.fg("accent", agentName) +
					`\n  ${theme.fg("dim", preview)}`,
				0,
				0,
			);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const statusIcon = (status: ReturnType<typeof resultStatus>) => {
				if (status === "running") return theme.fg("warning", "⏳");
				if (status === "aborted") return theme.fg("warning", "■");
				if (status === "failed") return theme.fg("error", "✗");
				return theme.fg("success", "✓");
			};
			const statusLabel = (status: ReturnType<typeof resultStatus>) => {
				if (status === "running") return theme.fg("warning", "运行中");
				if (status === "aborted") return theme.fg("warning", "中止");
				if (status === "failed") return theme.fg("error", "失败");
				return theme.fg("success", "成功");
			};

			const renderOne = (r: SingleResult): { header: string; error?: string; output: string; usage: string } => {
				const status = resultStatus(r);
				const model = r.model ? theme.fg("muted", ` ${r.model}`) : "";
				const header = `${statusIcon(status)} ${theme.fg("toolTitle", theme.bold(r.agent))}${model} ${statusLabel(status)}`;
				const error = r.errorMessage ? theme.fg("error", `Error: ${r.errorMessage}`) : undefined;
				const raw = getFinalOutput(r.messages) || (status === "running" ? "(running...)" : "(no output)");
				const output = expanded ? raw : collapseOutput(raw);
				const usage = formatUsageStats(r.usage, undefined);
				return { header, error, output, usage };
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const view = renderOne(r);
				if (expanded) {
					const container = new Container();
					container.addChild(new Text(view.header, 0, 0));
					if (view.error) container.addChild(new Text(view.error, 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(view.output.trim() || "(no output)", 0, 0, getMarkdownTheme()));
					if (view.usage) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", view.usage), 0, 0));
					}
					return container;
				}
				let text = view.header;
				if (view.error) text += `\n${view.error}`;
				text += `\n${theme.fg("toolOutput", view.output)}`;
				if (view.usage) text += `\n${theme.fg("dim", view.usage)}`;
				return new Text(text, 0, 0);
			}

			const running = details.results.filter((r) => r.exitCode === -1).length;
			const successCount = details.results.filter((r) => resultStatus(r) === "success").length;
			const failCount = details.results.filter((r) => {
				const s = resultStatus(r);
				return s === "failed" || s === "aborted";
			}).length;
			const icon = running > 0 ? theme.fg("warning", "⏳") : failCount > 0 ? theme.fg("warning", "◐") : theme.fg("success", "✓");
			const status =
				running > 0
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;
			const title = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;

			if (expanded && running === 0) {
				const container = new Container();
				container.addChild(new Text(title, 0, 0));
				for (const r of details.results) {
					const view = renderOne(r);
					container.addChild(new Spacer(1));
					container.addChild(new Text(view.header, 0, 0));
					if (view.error) container.addChild(new Text(view.error, 0, 0));
					container.addChild(new Markdown(view.output.trim() || "(no output)", 0, 0, getMarkdownTheme()));
					if (view.usage) container.addChild(new Text(theme.fg("dim", view.usage), 0, 0));
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
				}
				return container;
			}

			let text = title;
			for (const r of details.results) {
				const view = renderOne(r);
				text += `\n\n${view.header}`;
				if (view.error) text += `\n${view.error}`;
				text += `\n${theme.fg("toolOutput", view.output)}`;
			}
			if (running === 0) {
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
			}
			return new Text(text, 0, 0);
		},
	});
}
