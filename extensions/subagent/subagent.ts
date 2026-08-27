/**
 * Subagent class — shared spawn + parse + envelope + render machinery.
 *
 * A `Subagent` instance is constructed with a static `SubagentSpec` (name,
 * systemPrompt, model/thinking/tools/noSkills). `.run()` spawns an isolated
 * child `pi --mode json -p` process, parses its JSON event stream, and returns
 * a terse model-facing envelope plus the child's verbatim output.
 *
 * Specialized subagents (finder, oracle) are pre-constructed instances with
 * baked-in specs; the inline `subagent` tool constructs a transient instance
 * per call from `~/.pi/agent/subagent.json`.
 *
 * Architecture Invariant: the model-facing tool parameters are only `task` and
 * `label`. model/thinking/tools/noSkills are NOT per-call params; they live in
 * the spec (code constants for specialized, subagent.json for inline).
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { getAgentDir, getMarkdownTheme, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

/** Byte cap on the verbatim child output embedded in the model-facing envelope. */
const OUTPUT_CAP = 50 * 1024;
const COLLAPSED_ITEM_COUNT = 10;

export interface SubagentSpec {
	/** Tool name; also used for the session subdir and TUI display. */
	name: string;
	systemPrompt: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	noSkills: boolean;
}

/** Model-facing parameters: only `task` and `label`. No `agent`, no per-call config. */
export const SubagentParams = Type.Object({
	task: Type.Optional(Type.String({ description: "Task for the child." })),
	label: Type.Optional(
		Type.String({ description: "Correlation label echoed in the result envelope (e.g. repo/feature name)." }),
	),
});

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SingleResult {
	agent: string;
	task: string;
	/** Optional caller-supplied correlation label, echoed in the model-facing envelope. */
	label?: string;
	thinking?: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	/** Absolute path to the child's persisted session JSONL, for observability/debugging. */
	sessionFile?: string;
	/** Child session id from the JSON session header. */
	sessionId?: string;
}

export interface SubagentDetails {
	results: SingleResult[];
}

type RunOpts = { label?: string };

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

const NON_SUCCESS_STOP_REASONS = new Set(["error", "aborted"]);

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
	thinking?: string,
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
	if (thinking) parts.push(thinking);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
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
	return result.exitCode !== 0 || NON_SUCCESS_STOP_REASONS.has(result.stopReason ?? "");
}

/** Single-word status for the model-facing envelope. */
function statusOf(result: SingleResult): string {
	if (result.stopReason === "aborted") return "aborted";
	return isFailedResult(result) ? "failed" : "done";
}

/**
 * The terse, model-facing header line. Carries only what the *tool* uniquely
 * knows (status, model, label, session, cost). The child's own output is passed
 * through verbatim by the caller — the tool does not impose a payload format.
 */
function buildEnvelope(result: SingleResult): string {
	const parts: string[] = [];
	if (result.label) parts.push(`label=${result.label}`);
	parts.push(`agent=${result.agent}`);
	parts.push(`status=${statusOf(result)}`);
	if (result.model) parts.push(`model=${result.model}`);
	if (result.thinking) parts.push(`thinking=${result.thinking}`);
	if (result.usage.turns) parts.push(`turns=${result.usage.turns}`);
	if (result.usage.cost) parts.push(`cost=${result.usage.cost.toFixed(4)}`);
	parts.push(`exit=${result.stopReason ?? "end"}`);
	if (result.sessionFile) parts.push(`session=${result.sessionFile}`);
	return `[${parts.join(" ")}]`;
}

/** Envelope header + the child's verbatim (byte-capped) output. */
function buildTaskBlock(result: SingleResult): string {
	return `${buildEnvelope(result)}\n${truncateOutput(getResultOutput(result))}`;
}

function truncateOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= OUTPUT_CAP) return output;

	let truncated = output.slice(0, OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
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

	return { command: "pi", args };
}

function failedSpecResult(name: string, task: string, error: string): SingleResult {
	return {
		agent: name,
		task,
		exitCode: 1,
		messages: [],
		stderr: error,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
	};
}

/**
 * A Subagent instance binds a `SubagentSpec` to the spawn/parse/envelope/render
 * machinery. Specialized subagents (finder, oracle) use a static spec; the
 * inline `subagent` tool constructs a transient instance per call.
 */
export class Subagent {
	constructor(readonly spec: SubagentSpec) {}

	/**
	 * Spawn an isolated child `pi --mode json -p` process for `task`, parse its
	 * JSON event stream, and return a terse envelope + verbatim output. The
	 * child's session is persisted under `sessions/<spec.name>/<runId>/` so
	 * aborted work stays inspectable.
	 */
	async run(
		cwd: string,
		task: string,
		signal: AbortSignal | undefined,
		onUpdate: OnUpdateCallback | undefined,
		makeDetails: (results: SingleResult[]) => SubagentDetails,
		opts?: RunOpts,
	): Promise<SingleResult> {
		const { spec } = this;
		// Persist the child's session so the main agent can read the full transcript
		// for debugging. This is the observability bridge: a path, not a framework.
		const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const sessionDir = path.join(getAgentDir(), "sessions", spec.name, runId);
		try {
			await fs.promises.mkdir(sessionDir, { recursive: true });
		} catch {
			/* best effort; pi will fall back to its default session dir */
		}

		const args: string[] = ["--mode", "json", "-p", "--session-dir", sessionDir];
		if (spec.model) args.push("--model", spec.model);
		if (spec.thinking) args.push("--thinking", spec.thinking);
		if (spec.tools && spec.tools.length > 0) args.push("--tools", spec.tools.join(","));
		if (spec.noSkills) args.push("--no-skills");

		let tmpPromptDir: string | null = null;
		let tmpPromptPath: string | null = null;

		const currentResult: SingleResult = {
			agent: spec.name,
			task,
			label: opts?.label,
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			model: spec.model,
			thinking: spec.thinking,
		};

		/** Resolve the child's persisted session JSONL (single file in our run dir). Idempotent. */
		const resolveSessionFile = () => {
			if (currentResult.sessionFile) return;
			try {
				const files = fs.readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
				if (files.length > 0) currentResult.sessionFile = path.join(sessionDir, files[0]);
			} catch {
				/* ignore */
			}
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
			if (spec.systemPrompt.trim()) {
				const tmp = await writePromptToTempFile(spec.name, spec.systemPrompt);
				tmpPromptDir = tmp.dir;
				tmpPromptPath = tmp.filePath;
				args.push("--system-prompt", tmpPromptPath);
			}

			args.push(`Task: ${task}`);
			let wasAborted = false;

			const exitCode = await new Promise<number>((resolve) => {
				const invocation = getPiInvocation(args);
				const proc = spawn(invocation.command, invocation.args, {
					cwd,
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
				});
				let buffer = "";

				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};

				const processLine = (line: string) => {
					if (!line.trim()) return;
					let event: any;
					try {
						event = JSON.parse(line);
					} catch {
						return;
					}

					if (event.type === "session" && event.id) {
						currentResult.sessionId = event.id;
						// The child writes its JSONL at session start, so the path is
						// available immediately — surface it live (for the human) and so it
						// is already attached if the run is aborted mid-flight.
						resolveSessionFile();
						emitUpdate();
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
							const reportedModel = msg.model as string | undefined;
							if (reportedModel && !currentResult.model) currentResult.model = reportedModel;
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

				proc.on("close", (code) => {
					if (buffer.trim()) processLine(buffer);
					resolve(code ?? 0);
				});

				proc.on("error", () => {
					resolve(1);
				});

				if (signal) {
					const onAbort = () => killProc();
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
			});

			currentResult.exitCode = exitCode;
			// Resolve the persisted session file path (fallback if the start event was missed).
			resolveSessionFile();
			// Abort no longer throws: return the partial result so completed work
			// is never discarded and the session path stays inspectable.
			if (wasAborted) currentResult.stopReason = "aborted";
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

	/** Build the model-facing envelope + verbatim (byte-capped) child output. */
	buildTaskBlock(result: SingleResult): string {
		return buildTaskBlock(result);
	}

	/** True if the result is a failure (non-zero exit or error/aborted stop). */
	isFailed(result: SingleResult): boolean {
		return isFailedResult(result);
	}

	/** Convenience for error-path results that still need a SingleResult shape. */
	failedResult(task: string, error: string): SingleResult {
		return failedSpecResult(this.spec.name, task, error);
	}

	/**
	 * Standard tool execute body shared by all subagent tools. Spawns the child
	 * for `params.task`, returns the envelope + verbatim output. The inline
	 * subagent also uses this after constructing a transient instance from
	 * subagent.json.
	 */
	async execute(
		_toolCallId: string,
		params: { task?: string; label?: string },
		signal: AbortSignal | undefined,
		onUpdate: OnUpdateCallback | undefined,
		ctx: { cwd: string },
	): Promise<AgentToolResult<SubagentDetails>> {
		const makeDetails = (results: SingleResult[]): SubagentDetails => ({ results });
		if (!params.task) {
			const failed = this.failedResult("", "`task` is required");
			failed.label = params.label;
			return {
				content: [{ type: "text", text: "Invalid parameters. Provide a `task`." }],
				details: makeDetails([failed]),
			};
		}
		const result = await this.run(ctx.cwd, params.task, signal, onUpdate, makeDetails, { label: params.label });
		return {
			content: [{ type: "text", text: this.buildTaskBlock(result) }],
			details: makeDetails([result]),
		};
	}

	renderCall(args: Record<string, unknown>, theme: any): Text {
		const preview = args.task
			? (args.task as string).length > 60
				? `${(args.task as string).slice(0, 60)}...`
				: (args.task as string)
			: "...";
		const text = `${theme.fg("toolTitle", theme.bold(this.spec.name))}\n  ${theme.fg("dim", preview)}`;
		return new Text(text, 0, 0);
	}

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: unknown },
		{ expanded }: { expanded: boolean },
		theme: any,
	): Text | Container {
		const details = result.details as SubagentDetails | undefined;
		if (!details || details.results.length === 0) {
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		}

		const mdTheme = getMarkdownTheme();

		const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
			const toShow = limit ? items.slice(-limit) : items;
			const skipped = limit && items.length > limit ? items.length - limit : 0;
			let text = "";
			if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
			for (const item of toShow) {
				if (item.type === "text") {
					const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
					text += `${theme.fg("toolOutput", preview)}\n`;
				} else {
					text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
				}
			}
			return text.trimEnd();
		};

		const r = details.results[0];
		const isError = isFailedResult(r);
		const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
		const displayItems = getDisplayItems(r.messages);
		const finalOutput = getFinalOutput(r.messages);

		if (expanded) {
			const container = new Container();
			let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}`;
			if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
			container.addChild(new Text(header, 0, 0));
			if (isError && r.errorMessage)
				container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
			container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
			if (displayItems.length === 0 && !finalOutput) {
				container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
			} else {
				for (const item of displayItems) {
					if (item.type === "toolCall")
						container.addChild(
							new Text(
								theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
								0, 0,
							),
						);
				}
				if (finalOutput) {
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
				}
			}
			const usageStr = formatUsageStats(r.usage, r.model, r.thinking);
			if (usageStr) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
			}
			if (r.sessionFile) container.addChild(new Text(theme.fg("dim", `session: ${r.sessionFile}`), 0, 0));
			return container;
		}

		let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}`;
		if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
		if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
		else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
		else {
			text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
			if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
		}
		const usageStr = formatUsageStats(r.usage, r.model, r.thinking);
		if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
		if (r.sessionFile) text += `\n${theme.fg("dim", `session: ${r.sessionFile}`)}`;
		return new Text(text, 0, 0);
	}
}

