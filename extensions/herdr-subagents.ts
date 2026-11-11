/**
 * pi-herdr-subagents 适配层：本包对该第三方扩展的全部依赖（工具名、环境变量、内部状态）集中在这里。
 * 上游改名或换实现时只改这个文件。不是 pi 扩展入口（package.json 未列出），只供 task-router 与 inline-subagent 引用。
 */

/** 包名，用于提示安装 */
export const PACKAGE_NAME = "pi-herdr-subagents";
export const INSTALL_HINT = `pi install npm:${PACKAGE_NAME}`;

/** 开新窗口执行角色的工具 */
export const WINDOW_TOOL = "subagent";

/** 上游提供的、与分派相关的全部工具（不能继续分派的子代理要禁用这些） */
export const SPAWN_TOOLS = ["subagent", "subagent_interrupt", "subagent_resume", "subagents_list"] as const;

/** 新窗口子代理向调用方提问的工具 */
export const ASK_TOOL = "caller_ping";

/** 新窗口子代理进程的环境变量前缀（启动普通会话时要清掉） */
export const ENV_PREFIX = "PI_SUBAGENT_";

/** 上游读取的禁用工具列表环境变量（只在 PI_SUBAGENT_ID 存在时生效） */
export const DENY_TOOLS_ENV = "PI_DENY_TOOLS";

/** 当前进程是否为上游开出的新窗口子代理，以及其角色名 */
export function windowWorker(env: NodeJS.ProcessEnv = process.env): { id: string; agent: string } | undefined {
	const id = env.PI_SUBAGENT_ID;
	return id ? { id, agent: env.PI_SUBAGENT_AGENT ?? "" } : undefined;
}

/** 上游内部运行状态（非公开 API）：本进程派生、尚未结束的子窗口数。读不到当 0。 */
const RUNTIME_KEY = Symbol.for("pi-subagents/runtime");
export function countRunningSubagents(): number {
	const map = (globalThis as Record<symbol, any>)[RUNTIME_KEY]?.runningSubagents;
	return map instanceof Map ? map.size : 0;
}
